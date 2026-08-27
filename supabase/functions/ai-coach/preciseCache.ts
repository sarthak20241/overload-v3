/**
 * The precise cache: research Super has already done, kept so it is never done twice.
 *
 * A web lookup is the most expensive thing this pipeline can do, and the thing it
 * finds out is a fact about a PRODUCT, not about the person who asked. Milky Mist
 * low fat paneer is 190 kcal/100 g for everybody. So the cost is paid once ever
 * per food and every later parse reads the answer, which is also why a hit lands
 * at Smart speed while a miss pays Super's latency.
 *
 * Two rules do the real work here, and both default to spending money rather than
 * being confidently wrong:
 *
 *   FRESHNESS. Products get reformulated and labels get corrected. A stale row is
 *   not "slightly old data", it is a wrong number wearing a verified badge. Past
 *   the TTL a row is not served at all - the lookup runs again. Both this module
 *   and precise_cache_get() in migration 0109 enforce that, because the one that
 *   matters is whichever one a future caller forgets to go through.
 *
 *   INDEPENDENCE. "Two sources agreed" is worth nothing when both sources are the
 *   same source. Three pages on one site are one reading however many times they
 *   repeat the number, so web readings are counted by HOST. Our own catalog does
 *   not count either: the lookup exists to check that row, and letting it vouch
 *   for itself makes every wrong row self-confirming.
 *   OFF is a full independent source (user decision 2026-08-27). We had discounted
 *   OFF rows that declare a FatSecret origin; that rule is gone, and the numbers we
 *   see from OFF stand on their own.
 *
 * LEGAL, and it is not a detail. FatSecret's terms allow using their data to serve
 * a user's request; they do not allow replicating their database (see fatsecret.ts).
 * Caching the facts we needed for one lookup is the former. So FatSecret readings
 * may sit in `evidence` and may inform a decide call, but they can never be one of
 * the independent sources that make a row verified, which is what makes a row
 * eligible to be copied into our own catalog by the nightly promotion job. That
 * exclusion is a licensing line, not a quality judgement, and it does not move.
 *
 * WIRING, deliberately not done here (Phase 7b owns the resolve fan-out):
 *   read   rpc('precise_cache_get', { p_key: cacheKey(name, brand) }) before the
 *          web fan-out. It returns nothing for a stale row, which IS the signal to
 *          look the food up again.
 *   write  upsert precise_cache on cache_key after a lookup, storing the readings
 *          and meetsVerificationBar()'s verdict. A re-verification must set
 *          last_verified_at = now(), or the row ages out on its first sighting.
 */

/** Per 100 base units (g or ml), the same basis as the foods table. */
export interface Per100 {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g?: number | null;
}

/** Where a reading came from. 'web' covers anything the web search returned, and
 *  those are told apart by host, not lumped together as one source. */
export type EvidenceProvider = "off" | "fatsecret" | "catalog" | "web";

export interface SourceReading {
  source: EvidenceProvider;
  /** URL or product ref. For web readings the HOST is the identity: three pages
   *  on one site are one source, however many of them agree. */
  ref?: string | null;
  /** Where a source says it got its numbers, when it says. NOTHING READS THIS
   *  today: OFF counts as independent whatever it declares (user decision
   *  2026-08-27). Kept on the shape so resolvers can record provenance now and we
   *  are not re-plumbing evidence the day it starts mattering. */
  derived_from?: EvidenceProvider | null;
  per_100: Per100;
}

/** A cache row as stored (macros flattened, the way the table holds them). */
export interface PreciseCacheRow {
  id: string;
  cache_key: string;
  display_name: string;
  brand: string | null;
  base_unit: "g" | "ml";
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  servings: { label: string; grams: number }[];
  evidence: SourceReading[];
  verified: boolean;
  source_note: string | null;
  last_verified_at: string;
}

/** Rows go stale after this. Duplicated in migration 0109's precise_cache_get();
 *  change one, change the other. */
export const PRECISE_CACHE_TTL_DAYS = 90;

/** How far two readings of the same food may sit apart and still count as agreeing. */
export const VERIFY_TOLERANCE = 0.10;

/** Below this the percentage is meaningless: black coffee at 2 kcal and at 3 kcal
 *  is 50% apart and identical in every way a person cares about. */
export const VERIFY_MIN_ABS_KCAL = 2;

/** How many independent sources must agree before a row is verified. */
export const MIN_INDEPENDENT_SOURCES = 2;

/**
 * The lookup key for a food.
 *
 * Deliberately literal: lowercase, accents folded, everything that is not a
 * letter or digit collapsed to a single space, brand kept as its own segment.
 * Word ORDER is preserved and words are NOT sorted, because "milk chocolate" and
 * "chocolate milk" are different foods and a key that cannot tell them apart is a
 * cache that serves the wrong one.
 *
 * No typo folding either. "panner" and "paneer" get different keys, so a typo
 * costs one extra lookup. That is the cheap direction to be wrong in: a miss
 * costs money, a false hit costs correctness.
 */
export function cacheKey(name: string, brand?: string | null): string {
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const n = norm(name ?? "");
  const b = norm(brand ?? "");
  return b ? `${b}|${n}` : n;
}

/** Is this row still worth serving? Anything else must trigger a fresh lookup. */
export function isFresh(lastVerifiedAt: string | Date, now: Date = new Date()): boolean {
  const t = lastVerifiedAt instanceof Date ? lastVerifiedAt : new Date(lastVerifiedAt);
  const ms = t.getTime();
  // An unparseable timestamp is treated as stale. We would rather pay for a
  // lookup than serve a row whose age we cannot establish.
  if (!Number.isFinite(ms)) return false;
  const ageDays = (now.getTime() - ms) / 86_400_000;
  return ageDays >= 0 && ageDays < PRECISE_CACHE_TTL_DAYS;
}

/**
 * The identity of a reading for independence purposes, or null if it can never
 * count toward the bar.
 *
 * FatSecret is excluded outright - both because of their terms and because a row
 * that only FatSecret vouches for is a row we must not copy into our catalog.
 * 'catalog' is excluded too: our own rows are what the web lookup is being used to
 * check, so counting them would let a row confirm itself.
 *
 * Identity is the SOURCE WE READ, not any origin it declares. derived_from is
 * recorded and ignored.
 */
export function independenceKey(r: SourceReading): string | null {
  const origin = r.source;
  if (origin === "fatsecret" || origin === "catalog") return null;
  if (origin === "off") return "off";
  // Web readings are identified by host: one site is one source no matter how
  // many of its pages repeat the same number.
  const host = hostOf(r.ref);
  return host ? `web:${host}` : "web:unknown";
}

function hostOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    return new URL(ref).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Do two energy readings agree closely enough to be the same product? */
export function kcalAgrees(a: number, b: number, tolerance = VERIFY_TOLERANCE): boolean {
  const ref = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(ref * tolerance, VERIFY_MIN_ABS_KCAL);
}

export interface VerificationResult {
  verified: boolean;
  /** The independent sources backing the stored number, for the badge and traces. */
  agreeing: string[];
}

/**
 * Does the evidence support the number we are about to store?
 *
 * Note what is being asked: not "do any two readings agree with each other" but
 * "do two independent sources agree with THE VALUE WE KEPT". Those come apart when
 * three sources disagree three ways and decide picks one of them - a pairwise test
 * would happily verify a pair that lost the argument.
 */
export function meetsVerificationBar(
  kcal: number,
  evidence: SourceReading[],
  tolerance = VERIFY_TOLERANCE,
): VerificationResult {
  const agreeing = new Set<string>();
  for (const r of evidence ?? []) {
    const key = independenceKey(r);
    if (!key) continue;
    if (kcalAgrees(kcal, r.per_100?.kcal ?? NaN, tolerance)) agreeing.add(key);
  }
  const list = [...agreeing].sort();
  return { verified: list.length >= MIN_INDEPENDENT_SOURCES, agreeing: list };
}
