// Tavily client: web search and page extraction for Precise's web lookup.
//
// Why Tavily and not Anthropic's server-side web_search. The server tool pastes
// every result page into Haiku's context and bills us to read all of it, relevant
// or not: measured at about 39k input tokens per Precise log, 60% of the cost.
// Tavily hands the results to OUR code first - title, url, a few relevant chunks
// and optionally the cleaned page text - so Jev can drop the pages that are not
// about this food before a single token is spent reading them.
//
// Runtime-agnostic on purpose, like jev.ts and parseMeal.ts: no Deno globals,
// no jsr:/https: imports, fetch injected. That lets the probe drive the real
// code from Node.
//
// Never throws. A search provider that is down must degrade to the fallback
// lookup, never take a meal log with it.

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

export interface TavilyDeps {
  apiKey: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  abortSignal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface TavilySearchOptions {
  /** Boosts results from one country ("india"). Tavily only honours it for
   *  topic "general", which is the only topic we send. */
  country?: string | null;
  /** Sites to rank higher. Sent with include_domains_mode "prefer", never
   *  "restrict": a wrong guess must not hide the one page that has the label. */
  preferDomains?: string[];
  excludeDomains?: string[];
  /** 0-20. Default 8: enough to find two sites, few enough for Jev to judge. */
  maxResults?: number;
  /** "basic" costs 1 credit, "advanced" 2. */
  depth?: "basic" | "advanced";
}

export interface TavilyResult {
  title: string;
  url: string;
  /** Up to 3 query-relevant chunks of the page, 500 characters each. */
  content: string;
  score: number;
  /** Cleaned page text, when include_raw_content was asked for and Tavily had it. */
  raw_content: string | null;
}

export type TavilyFailure =
  | "no_key"
  | "auth"
  | "invalid_request"
  | "rate_limited"
  | "out_of_credits"
  | "timeout"
  | "http_error"
  | "bad_response";

export type TavilySearchResult =
  | { ok: true; results: TavilyResult[]; credits: number }
  | { ok: false; failure: TavilyFailure; detail: string; credits: number };

export type TavilyExtractResult =
  | { ok: true; pages: { url: string; raw_content: string }[]; credits: number }
  | { ok: false; failure: TavilyFailure; detail: string; credits: number };

function failureFor(status: number): TavilyFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 429) return "rate_limited";
  // Tavily answers 432 / 433 when the plan's credits or its pay-as-you-go
  // limit are used up. Named on its own so the logs say "top up", not "bug".
  if (status === 432 || status === 433) return "out_of_credits";
  return "http_error";
}

async function post(
  url: string,
  body: Record<string, unknown>,
  deps: TavilyDeps,
): Promise<{ ok: true; data: any } | { ok: false; failure: TavilyFailure; detail: string }> {
  if (!deps.apiKey) return { ok: false, failure: "no_key", detail: "TAVILY_API_KEY not set" };
  const fetchFn = deps.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  if (deps.abortSignal?.aborted) controller.abort();
  const onAbort = () => controller.abort();
  deps.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, failure: failureFor(res.status), detail: `${res.status} ${text.slice(0, 160)}` };
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { ok: false, failure: "bad_response", detail: "not json" };
    return { ok: true, data };
  } catch (e) {
    const aborted = controller.signal.aborted;
    return { ok: false, failure: aborted ? "timeout" : "http_error", detail: String(e).slice(0, 160) };
  } finally {
    clearTimeout(timer);
    deps.abortSignal?.removeEventListener("abort", onAbort);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * One search. Costs 1 credit (basic) or 2 (advanced) whether or not it finds
 * anything, so `credits` is reported on failure too when the request reached
 * Tavily and was billed. A request refused before billing (no key, 4xx) is 0.
 *
 * If Tavily rejects the optional knobs (a renamed parameter would do it), the
 * search is retried ONCE with only the query. Losing the country boost is a
 * worse result; losing the search is no result.
 */
export async function tavilySearch(
  query: string,
  opts: TavilySearchOptions,
  deps: TavilyDeps,
): Promise<TavilySearchResult> {
  const depth = opts.depth ?? "basic";
  const cost = depth === "advanced" ? 2 : 1;
  const base: Record<string, unknown> = {
    query,
    topic: "general",
    search_depth: depth,
    max_results: Math.min(Math.max(opts.maxResults ?? 8, 1), 20),
    include_raw_content: "text",
    include_answer: false,
  };
  const full: Record<string, unknown> = { ...base };
  if (opts.country) full.country = opts.country;
  if (opts.preferDomains?.length) {
    full.include_domains = opts.preferDomains;
    full.include_domains_mode = "prefer";
  }
  if (opts.excludeDomains?.length) full.exclude_domains = opts.excludeDomains;
  const hasOptional = Object.keys(full).length > Object.keys(base).length;

  let res = await post(TAVILY_SEARCH_URL, full, deps);
  if (!res.ok && res.failure === "invalid_request" && hasOptional) {
    deps.log?.(`[tavily] optional params rejected, retrying bare: ${res.detail}`);
    res = await post(TAVILY_SEARCH_URL, base, deps);
  }
  if (!res.ok) return { ...res, credits: 0 };

  const raw = Array.isArray(res.data.results) ? res.data.results : [];
  const results: TavilyResult[] = [];
  for (const r of raw) {
    const url = str(r?.url);
    if (!url) continue;
    results.push({
      title: str(r?.title).slice(0, 300),
      url: url.slice(0, 500),
      content: str(r?.content).slice(0, 2000),
      score: typeof r?.score === "number" && Number.isFinite(r.score) ? r.score : 0,
      raw_content: typeof r?.raw_content === "string" && r.raw_content.trim() ? r.raw_content : null,
    });
  }
  return { ok: true, results, credits: cost };
}

/**
 * Cleaned text of specific pages, for results Jev judged relevant whose search
 * text held no nutrition panel. Billed per 5 successful pages (basic), so up to
 * 5 urls cost 1 credit.
 */
export async function tavilyExtract(urls: string[], deps: TavilyDeps): Promise<TavilyExtractResult> {
  const list = urls.slice(0, 5);
  if (list.length === 0) return { ok: true, pages: [], credits: 0 };
  const res = await post(TAVILY_EXTRACT_URL, { urls: list, extract_depth: "basic", format: "text", timeout: 20 }, deps);
  if (!res.ok) return { ...res, credits: 0 };
  const raw = Array.isArray(res.data.results) ? res.data.results : [];
  const pages = raw
    .map((p: any) => ({ url: str(p?.url), raw_content: str(p?.raw_content) }))
    .filter((p: { url: string; raw_content: string }) => p.url && p.raw_content.trim());
  return { ok: true, pages, credits: pages.length > 0 ? Math.ceil(pages.length / 5) : 0 };
}
