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
 * LEGAL, and it is not a detail. FatSecret's API terms allow using their data to
 * serve a user's request; they do not allow replicating their database (see
 * fatsecret.ts). Caching the facts we needed for one lookup is the former.
 *
 * That restriction follows the API, not the brand name (Sarthak, 2026-09-05). A
 * fatsecret.co.in page returned by a WEB SEARCH is a public web page like any
 * other, we accepted no terms to read it, and the number on it is the
 * manufacturer's printed panel - a fact, and republishing a fact does not create
 * ownership of it. So a public page counts toward verification like any other
 * host, while a reading actually derived from the API does not.
 *
 * independenceKey draws that line on the reading's own `via` field, set by
 * whoever built it. NOT on whether it carries a URL: FatSecret's food.get
 * returns a food_url, so a URL test would let API evidence in the moment anyone
 * cited it. Unknown provenance never counts.
 *
 * The old rule excluded both halves and it cost real answers: the Milky Mist
 * paneer row is verified: false holding a correct 190 kcal, purely because its
 * second source was a FatSecret URL rather than any other site's.
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

/**
 * What ONE source said, which is not the same shape as what we conclude.
 *
 * A page can print energy and leave protein off the panel entirely, and null is
 * how that is recorded. It has to be distinguishable from a printed zero: oil
 * genuinely contains 0 g protein, so "treat 0 as missing" would be wrong for
 * exactly the foods where the zero is real. Only `kcal` is required - a reading
 * with no energy is not a reading at all.
 */
export interface ReadingPer100 {
  kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
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
  /**
   * HOW this reading was obtained, which for FatSecret decides whether it can
   * count toward verification. Only "web_search" does.
   *
   * This is recorded explicitly rather than inferred from the ref, and the
   * difference matters. The first cut of this rule used "has an http(s) URL" as
   * a proxy for "found on a public page", which held only because fatsecret.ts
   * happens not to set a ref today. FatSecret's own food.get returns a food_url,
   * so the obvious future change - citing it on API-derived evidence - would
   * have silently passed that test and counted toward promotion into the shared
   * catalog. A proxy that fails open is not a legal boundary.
   *
   * Absent means unknown, and unknown never counts for FatSecret. Adding a
   * citation to an API response cannot flip that; only setting this field can.
   */
  via?: "web_search" | "api";
  /** Reading shape, not row shape: macros may be null where the page was silent. */
  per_100: ReadingPer100;
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
  if (n || b) return b ? `${b}|${n}` : n;

  // NOTHING SURVIVED NORMALISATION, which happens for a name written entirely
  // outside ASCII - "\u092a\u0928\u0940\u0930", "\u8c46\u8150". The normaliser keeps only [a-z0-9], so those
  // collapse to the empty string, and every one of them would then share the
  // single cache row keyed "". That is the false hit this file's own header
  // calls the expensive kind: a miss costs a lookup, a hit costs correctness,
  // and here paneer would be served tofu's macros.
  //
  // So fall back to the code points, which are stable, distinct per input, and
  // still a plain ASCII key. Prefixed `u:` so it can never collide with a
  // normalised key, and capped because cache_key is an indexed column and a
  // pasted paragraph should not become the index entry.
  const raw = `${brand ?? ""} ${name ?? ""}`.trim().slice(0, 120);
  const points = Array.from(raw)
    .map((c) => (c.codePointAt(0) ?? 0).toString(36))
    .join("-");
  return `u:${points}`;
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
 * FatSecret splits on `via`: a page a web search found counts as its host, a
 * reading from their API never counts, and unknown provenance is treated as the
 * API. 'catalog' is excluded outright: our own rows are what the web lookup is
 * being used to check, so counting them would let a row confirm itself.
 *
 * Identity is the SOURCE WE READ, not any origin it declares. derived_from is
 * recorded and ignored.
 */
export function independenceKey(r: SourceReading): string | null {
  const origin = r.source;
  if (origin === "catalog") return null;
  if (origin === "off") return "off";
  // FatSecret splits in two, and only one half is restricted (Sarthak, 2026-09-05).
  //
  //   Their API is a contract. We accepted terms to call it, and those terms
  //   allow using the data to answer a user and forbid replicating the database.
  //   A reading from there stays out.
  //
  //   A fatsecret.co.in page a WEB SEARCH landed on is a public web page. We
  //   agreed to nothing to read it, and the number on it is the manufacturer's
  //   own printed panel - a fact, which nobody owns by republishing. Excluding it
  //   was costing real answers: the Milky Mist paneer row is verified: false with
  //   a correct 190 kcal, because its second source happened to be a FatSecret
  //   URL rather than any other site's.
  //
  // The discriminator is `via`, set by whoever built the reading, NOT a guess
  // from the ref. An earlier cut of this used "carries an http(s) URL" as a
  // stand-in for "came off a public page". That was wrong in the dangerous
  // direction: FatSecret's food.get returns a food_url, so the natural future
  // change of citing it on API-derived evidence would have passed the test and
  // started counting toward promotion into the shared catalog - silently, and
  // exactly against the terms the rule exists to respect.
  //
  // Unknown provenance never counts. Only an explicit "web_search" does, so a
  // reading can never drift into eligibility by gaining a citation.
  if (origin === "fatsecret") {
    if (r.via !== "web_search") return null;
    const host = hostOf(r.ref);
    // Deliberately STRICTER than the plain-web branch below, which buckets a
    // ref-less reading as "web:unknown". Here a reading with no readable host
    // is dropped instead. The asymmetry is the point: this is the branch that
    // decides whether FatSecret data becomes eligible for the shared catalog,
    // and "we cannot tell which page this was" is not a good enough answer to
    // that question. An ordinary site being wrong costs a number; this being
    // wrong costs a licence.
    return host ? `web:${host}` : null;
  }
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
