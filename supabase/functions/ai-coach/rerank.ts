/**
 * Cross-encoder rerank for parse_meal candidates (P2 of the tiers plan).
 *
 * Sits in ONE place: after the sources merge in resolveOneItem, before
 * anything picks. The trigram/semantic search and the ranking-layer priors
 * (migration 0102) get the right rows INTO the list; this orders them by
 * reading the user's phrase against each candidate name, which is the judgment
 * call code cannot make ("2 whole eggs" vs "Eggs, chicken, yolk, raw").
 *
 * Vendor: Voyage rerank-2.5-lite. Chosen because it is the fastest API option
 * (~300-400ms measured live 2026-08-22), the project already holds a
 * VOYAGE_API_KEY for semantic-search embeddings, and it prices per token
 * (a meal item is ~50 tokens, so effectively free). Fail-open by design: any
 * error returns null and the caller keeps its existing order.
 *
 * The margin (top score minus runner-up) is returned for P3: a wide margin is
 * what will let Smart skip the decide call entirely.
 */

const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
const RERANK_MODEL = "rerank-2.5-lite";
// Measured ~400ms warm. The budget is deliberately tight: rerank runs after
// the source wait, so every ms here is on the meal's critical path.
const RERANK_TIMEOUT_MS = 900;

export interface RerankResult {
  /** Candidate indexes in best-first order. Same length as the input docs. */
  order: number[];
  /** Top score minus runner-up score; 1 when there is only one candidate. */
  margin: number;
  topScore: number;
}

export async function voyageRerank(
  apiKey: string,
  query: string,
  docs: string[],
  fetchFn: typeof fetch,
  log?: (msg: string) => void,
): Promise<RerankResult | null> {
  if (docs.length === 0) return null;
  if (docs.length === 1) return { order: [0], margin: 1, topScore: 1 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
  try {
    const res = await fetchFn(VOYAGE_RERANK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents: docs, top_k: docs.length }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log?.(`[parse_meal] rerank HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as {
      data?: Array<{ index?: number; relevance_score?: number }>;
    };
    const rows = (data.data ?? [])
      .filter((r) => typeof r.index === "number" && typeof r.relevance_score === "number")
      .sort((a, b) => (b.relevance_score! - a.relevance_score!));
    if (rows.length !== docs.length) {
      log?.(`[parse_meal] rerank returned ${rows.length}/${docs.length} rows, ignoring`);
      return null;
    }
    return {
      order: rows.map((r) => r.index!),
      margin: rows.length > 1 ? rows[0].relevance_score! - rows[1].relevance_score! : 1,
      topScore: rows[0].relevance_score!,
    };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    log?.(`[parse_meal] rerank ${aborted ? "timed out" : "threw"}: ${aborted ? "" : String(e).slice(0, 80)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
