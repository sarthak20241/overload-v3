/**
 * FatSecret Platform API source for parse_meal (tier 2b, alongside live OFF).
 *
 * WHY OAUTH 1.0 AND NOT 2.0. FatSecret's OAuth 2.0 flow is IP-restricted: a
 * key/secret only works from whitelisted addresses (15 max, and CIDR ranges are
 * Premier-only). Supabase edge functions egress from dynamic addresses, so
 * OAuth 2.0 would break at random. OAuth 1.0 signed requests carry the proof in
 * an HMAC-SHA1 signature instead of the source IP, so they work from anywhere.
 * That is the whole reason this module hand-rolls request signing.
 *
 * WHY search v1 + food.get.v4 (verified live 2026-08-22). foods.search.v3
 * (structured servings inline) is NOT available to this key: server.api
 * answers it with error 10 "Unknown method", while plain foods.search and
 * food.get.v4 both work. v1 search returns nutrition only as a prose string,
 * so the client does search -> top-N food.get.v4 in parallel, which yields the
 * same structured servings at the cost of N+1 calls (~600ms total, and N is
 * capped to keep the 5k/day Basic quota sane).
 *
 * LEGAL. FatSecret rows are NOT backfilled into `foods` (unlike OFF, which is
 * ODbL). Their terms allow using the data to serve a user request, not
 * replicating their database. So candidates from here carry an EPHEMERAL id
 * (see EPHEMERAL_ID_PREFIX): enough to be picked by decide and to key the
 * per-100 recompute in memory, stripped before anything is logged. See
 * scripts/diet-catalog/README.md for the same rule on other proprietary sources.
 *
 * BASIC vs PREMIER. `region`/`language` are Premier-exclusive parameters. On
 * Basic we simply omit them and get the US dataset. When Premier lands, set
 * FATSECRET_REGION and nothing else changes.
 */

import { EPHEMERAL_ID_PREFIX } from "./parseMeal.ts";
import type { CandidateFood, ServingOption } from "./parseMeal.ts";

const FS_REST_URL = "https://platform.fatsecret.com/rest/server.api";
// Their search has a cold-cache penalty: ~4s the first time a term is queried,
// ~1.1s warm (measured live 2026-08-22). Resolve runs sources in parallel and
// the meal waits for the slowest, so we cap search + hydrate at ~2.8s total
// and accept that a cold term misses once (catalog and OFF still answer, and
// the term is warm for the next parse).
const FS_SEARCH_TIMEOUT_MS = 1600;
const FS_GET_TIMEOUT_MS = 1200;
// Search wider than we fetch: v1 search is one cheap call, but every candidate
// we hydrate is its own food.get.v4 call against the 5k/day Basic quota.
const FS_SEARCH_RESULTS = 5;
const FS_HYDRATE_LIMIT = 3;

export interface FatSecretCreds {
  consumerKey: string;
  consumerSecret: string;
  /** Premier only. Omit on Basic (US dataset). */
  region?: string;
  language?: string;
}

/** RFC3986 percent-encoding. encodeURIComponent leaves !'()* alone, and OAuth
 *  signatures do not match if those survive unencoded. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Build the full signed query string for a GET.
 *
 * The base string is `GET&<enc(url)>&<enc(sorted params))>`, and params must be
 * sorted by encoded name then encoded value. Signing key is
 * `<consumer_secret>&<access_secret>`; the trailing `&` is required even though
 * we have no access secret (these are signed, not delegated, requests).
 */
export async function signedQuery(
  params: Record<string, string>,
  creds: FatSecretCreds,
  nonce: string,
  timestamp: string,
): Promise<string> {
  const all: Record<string, string> = {
    ...params,
    oauth_consumer_key: creds.consumerKey,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_nonce: nonce,
    oauth_version: "1.0",
  };
  const normalized = Object.keys(all)
    .map((k) => [enc(k), enc(all[k])] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `GET&${enc(FS_REST_URL)}&${enc(normalized)}`;
  const signature = await hmacSha1Base64(`${enc(creds.consumerSecret)}&`, base);
  return `${normalized}&oauth_signature=${enc(signature)}`;
}

/** FatSecret returns a bare object when there is exactly one child and an array
 *  when there are several. Every list in their payload needs this. */
function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") return [v as Record<string, unknown>];
  return [];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn one FatSecret food into our per-100 candidate shape.
 *
 * Their servings carry ABSOLUTE values for that serving ("1 cup" -> 220 kcal),
 * while `foods.kcal` in our world is always per 100 base units. So we find a
 * serving with a metric amount and rescale. A 100 g / 100 ml serving is
 * preferred because it needs no scaling at all; v4 adds exactly such a serving
 * (serving_id 0) to branded foods, so it is usually there.
 */
export function toCandidate(food: Record<string, unknown>): CandidateFood | null {
  const name = typeof food.food_name === "string" ? food.food_name.trim() : "";
  if (!name) return null;
  const servings = asArray((food.servings as Record<string, unknown> | undefined)?.serving);
  if (servings.length === 0) return null;

  // Serving anchors for decide, and the basis row for our per-100 rescale.
  const options: ServingOption[] = [];
  let basis: { serving: Record<string, unknown>; amount: number; unit: string } | null = null;
  for (const s of servings) {
    const amount = num(s.metric_serving_amount);
    const unit = String(s.metric_serving_unit ?? "").toLowerCase();
    const label = typeof s.serving_description === "string" ? s.serving_description.trim() : "";
    if (amount === null || amount <= 0 || (unit !== "g" && unit !== "ml")) continue;
    if (label) options.push({ label, grams: amount, is_default: s.is_default === "1" });
    // Prefer an exact 100 basis; otherwise keep the first usable one.
    if (!basis || (amount === 100 && basis.amount !== 100)) basis = { serving: s, amount, unit };
  }
  if (!basis) return null;

  const f = 100 / basis.amount;
  const per = (key: string): number | null => {
    const n = num(basis!.serving[key]);
    return n === null ? null : Math.round(n * f * 10) / 10;
  };
  const kcal = per("calories");
  const protein = per("protein");
  const carb = per("carbohydrate");
  const fat = per("fat");
  // A partial macro panel is not something we can log against.
  if (kcal === null || protein === null || carb === null || fat === null) return null;

  const brand = typeof food.brand_name === "string" && food.brand_name.trim()
    ? food.brand_name.trim()
    : null;
  const fsId = food.food_id === undefined || food.food_id === null
    ? null
    : String(food.food_id).trim();
  if (!fsId) return null;
  return {
    // EPHEMERAL, never a row in `foods`: we do not persist FatSecret data (see
    // header). decide still needs to address the candidate, so it gets a
    // prefixed id that keys the in-memory per-100 map and is stripped before
    // anything is logged.
    food_id: `${EPHEMERAL_ID_PREFIX}${fsId}`,
    name,
    brand,
    base_unit: basis.unit === "ml" ? "ml" : "g",
    kcal,
    protein_g: protein,
    carb_g: carb,
    fat_g: fat,
    fiber_g: per("fiber"),
    servings: options,
    source: "fatsecret",
  };
}

/** One signed GET against server.api. Returns the parsed JSON body, or null on
 *  transport failure / API error (their errors come back as HTTP 200 with an
 *  `error` object, so a status check alone is not enough). */
async function callApi(
  params: Record<string, string>,
  creds: FatSecretCreds,
  fetchFn: typeof fetch,
  timeoutMs: number,
  log?: (msg: string) => void,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const qs = await signedQuery(
      { ...params, format: "json" },
      creds,
      crypto.randomUUID().replace(/-/g, ""),
      String(Math.floor(Date.now() / 1000)),
    );
    const res = await fetchFn(`${FS_REST_URL}?${qs}`, { signal: controller.signal });
    if (!res.ok) {
      log?.(`[parse_meal] FatSecret HTTP ${res.status} (${params.method})`);
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const err = data?.error as Record<string, unknown> | undefined;
    if (err) {
      log?.(`[parse_meal] FatSecret error ${err.code} (${params.method}): ${String(err.message).slice(0, 120)}`);
      return null;
    }
    return data;
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    log?.(`[parse_meal] FatSecret ${aborted ? "timed out" : "threw"} (${params.method})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search FatSecret for a food. Returns [] on any failure: this is one source
 * among several, and a dead source must degrade the meal, never fail it.
 *
 * Two-step: v1 search for ids (the only search this key can call), then
 * food.get.v4 for the top few IN PARALLEL to hydrate structured servings.
 */
export async function searchFatSecret(
  query: string,
  creds: FatSecretCreds,
  fetchFn: typeof fetch,
  log?: (msg: string) => void,
): Promise<CandidateFood[]> {
  const searchParams: Record<string, string> = {
    method: "foods.search",
    search_expression: query,
    max_results: String(FS_SEARCH_RESULTS),
  };
  // Premier-only knobs. Sending them on Basic is an error, so only when set.
  if (creds.region) searchParams.region = creds.region;
  if (creds.language) searchParams.language = creds.language;

  const data = await callApi(searchParams, creds, fetchFn, FS_SEARCH_TIMEOUT_MS, log);
  if (!data) return [];
  const foods = asArray((data.foods as Record<string, unknown> | undefined)?.food);
  const ids = foods
    .map((f) => (f.food_id === undefined || f.food_id === null ? "" : String(f.food_id)))
    .filter(Boolean)
    .slice(0, FS_HYDRATE_LIMIT);
  if (ids.length === 0) return [];

  const hydrated = await Promise.all(ids.map(async (id) => {
    const d = await callApi({ method: "food.get.v4", food_id: id }, creds, fetchFn, FS_GET_TIMEOUT_MS, log);
    const food = d?.food as Record<string, unknown> | undefined;
    return food ? toCandidate(food) : null;
  }));
  return hydrated.filter((c): c is CandidateFood => c !== null);
}
