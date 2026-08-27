/**
 * Cache-to-catalog promotion: the decision half (Phase 7d).
 *
 * Super pays for a food's research once. This is how the rest of the app gets to
 * keep it: a nightly pass copies cache rows that have earned it into `foods`, so
 * Fast and Smart find them by plain catalog search instead of being ungrounded on
 * a food we already know cold. Nothing here runs inside a parse. A promotion is a
 * write to the shared catalog and it happens on its own clock, where a mistake can
 * be found before thousands of people log against it.
 *
 * The bar is high because the failure is quiet. A promoted row is indistinguishable
 * from a curated one at search time, and a wrong row does not degrade to an
 * estimate, it degrades to a confident wrong number. So:
 *
 *   1. VERIFIED, re-derived. Two independent sources within 10% of the number we
 *      would publish, computed from the stored evidence rather than read off the
 *      `verified` flag. The flag was written by whatever code shipped that day; the
 *      evidence is the thing that can still be checked. FatSecret can never be one
 *      of the two (their terms allow serving a request, not replicating their DB),
 *      and neither can our own catalog, which is what the lookup was checking.
 *   2. FRESH. We do not publish facts we would no longer serve ourselves.
 *   3. PHYSICALLY POSSIBLE. The per-100 basis has to describe a food that could
 *      exist, and its calories have to roughly follow from its own macros.
 *   4. NOT ALREADY THERE. Checked before any write. A second "Paneer" row does not
 *      add coverage, it splits the ranking signals between two rows so neither wins
 *      its own search, which is worse than not promoting at all.
 *
 * THERE IS NO USAGE BAR (user decision 2026-08-27). An earlier draft required a
 * food to have been logged twice, or by two people, before it could be promoted.
 * It is gone: label-derived data that two independent sources agree on is accurate
 * enough to publish on its own, and waiting for a second person to eat the same
 * branded product mostly just kept the catalog thin. The consequence is that the
 * physics checks are now the ONLY gate standing between a verified lookup and the
 * shared catalog, which is why they run here rather than being left to the parse
 * pipeline that will read these rows back.
 *
 * This module is pure. All of it is decisions about rows already in memory; the
 * fetching and writing live in tools/promote-food-cache/run.ts, so the rules can be
 * tested against the real bug corpus without a database.
 */

import { nearWord } from "./textMatch.ts";
// implausiblePer100 is imported rather than re-stated so the physical ceilings have
// one definition. parseMeal.ts deliberately carries no runtime-specific imports (it
// is driven from Node by the eval harness), so this costs nothing at load.
import { implausiblePer100 } from "./parseMeal.ts";
import {
  isFresh,
  meetsVerificationBar,
  type Per100,
  type SourceReading,
  VERIFY_TOLERANCE,
} from "./preciseCache.ts";

/** How far kcal may sit from 4P + 4C + 9F and still be a real label.
 *  Same 30% as checkAtwater in parseMeal.ts, and generous for the same measured
 *  reason: printed panels legitimately break strict Atwater through fiber netting,
 *  sugar alcohols, alcohol and rounding. This is a physics floor for catching a row
 *  whose numbers contradict each other, not a precision test. */
export const ATWATER_TOLERANCE = 0.3;

/** Below this, a percentage says nothing: black coffee is a couple of kcal either
 *  way and every one of them is 100% of the other. */
const ATWATER_MIN_KCAL = 20;

/** How far a catalog row's energy may sit from ours before "same name" stops
 *  meaning "same food". Same number as the verification bar on purpose: one
 *  tolerance for "these two readings describe one product". */
export const DUPLICATE_KCAL_TOLERANCE = VERIFY_TOLERANCE;

/** Words that do not decide WHICH food this is, so they must not decide whether a
 *  catalog row is a duplicate. Kept short: every word here is a word the dedup
 *  check stops looking at.
 *  NOTE: acceptCandidate.ts (Phase 6) carries a sibling list for the acceptance
 *  gate. When both are on one branch, collapse them into one shared list. */
const NON_IDENTIFYING = new Set([
  "fresh", "homemade", "home", "made", "pure", "natural", "organic", "farm",
  "packet", "packaged", "tetra", "pack", "a", "an", "the", "of", "with",
]);

export interface PromotionCandidate {
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
  last_verified_at: string;
  /** Set once this row has been promoted or matched to an existing catalog row. */
  promoted_food_id: string | null;
}

/** An existing catalog row, as the dedup check needs to see it. */
export interface CatalogRow {
  id: string;
  name: string;
  brand: string | null;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  source: string;
  last_verified_at: string | null;
}

export type SkipReason =
  | "expired"
  | "unverified"
  | "implausible"
  | "catalog-conflict"
  | "already-current"
  | "promoted-row-missing";

export type PromotionDecision =
  /** Insert a new global catalog row. */
  | { action: "promote"; agreeing: string[] }
  /** We already published this one and the evidence has moved on. Update in place. */
  | { action: "refresh"; food_id: string; agreeing: string[] }
  /** The catalog already covers this food. Record the match so we stop reconsidering
   *  it every night, and write nothing to `foods`. */
  | { action: "link"; food_id: string }
  | { action: "skip"; reason: SkipReason; detail?: string };

function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NON_IDENTIFYING.has(w));
}

/**
 * Is this catalog row the same food, or merely a food with some of the same words?
 *
 * BIDIRECTIONAL, and that is the whole difference from the acceptance gate. When
 * decide picks a row to log against, a row may say MORE than the user did: "milk"
 * is fairly served by "Amul Taaza Toned Milk". Here the question is the opposite
 * one, "would publishing my row duplicate this one", and a row that says LESS is
 * not a duplicate: promoting "Milky Mist Low Fat Paneer" next to a plain "Paneer"
 * adds the grade the catalog was missing, which is exactly the gap Super exists to
 * fill. Only a row that covers our words AND is covered BY them is the same food.
 */
export function isSameFood(
  ourName: string,
  ourBrand: string | null,
  row: CatalogRow,
): boolean {
  const ours = contentWords(`${ourName} ${ourBrand ?? ""}`);
  const theirs = contentWords(`${row.name} ${row.brand ?? ""}`);
  if (ours.length === 0 || theirs.length === 0) return false;
  const covers = (a: string[], b: string[]) => a.every((w) => b.some((x) => nearWord(w, x)));
  return covers(ours, theirs) && covers(theirs, ours);
}

export interface DuplicateMatch {
  row: CatalogRow;
  /** Same name, materially different energy. Someone is wrong and it is not for a
   *  nightly job to decide who. */
  conflict: boolean;
}

export function findDuplicate(
  cand: { display_name: string; brand: string | null; kcal: number },
  catalog: CatalogRow[],
): DuplicateMatch | null {
  for (const row of catalog) {
    if (!isSameFood(cand.display_name, cand.brand, row)) continue;
    const ref = Math.max(Math.abs(cand.kcal), Math.abs(row.kcal));
    const conflict = ref > 0 && Math.abs(cand.kcal - row.kcal) / ref > DUPLICATE_KCAL_TOLERANCE;
    return { row, conflict };
  }
  return null;
}

/**
 * Why these numbers cannot describe a real food, or null if they could.
 *
 * Two questions, both about physics rather than taste. Is the per-100 basis
 * possible at all (more calories than pure fat, macros that outweigh the food)?
 * And do the calories follow from the macros the same row states? A label that
 * disagrees with itself past 30% is not a label convention, it is a row where
 * someone read the wrong column, and it is the failure a catalog row propagates
 * furthest: every future search finds it and nothing downstream questions it.
 *
 * The parse pipeline only FLAGS an Atwater break on label-derived lines, and that
 * is right for one meal in front of one person who can see the chip. Publishing to
 * everyone has no one reading a chip, so here it rejects.
 */
export function failsPhysics(per100: Per100): string | null {
  const bad = implausiblePer100(per100);
  if (bad) return bad;
  const atwater = 4 * per100.protein_g + 4 * per100.carb_g + 9 * per100.fat_g;
  if (atwater < ATWATER_MIN_KCAL && per100.kcal < ATWATER_MIN_KCAL) return null;
  const ref = Math.max(per100.kcal, atwater);
  if (ref <= 0) return null;
  if (Math.abs(per100.kcal - atwater) / ref > ATWATER_TOLERANCE) {
    return `${Math.round(per100.kcal)} kcal per 100 does not follow from its macros (${Math.round(atwater)})`;
  }
  return null;
}

/** Have these macros moved enough since we published them to be worth a rewrite? */
export function macrosMoved(published: Per100, current: Per100): boolean {
  const moved = (a: number, b: number) => Math.abs(a - b) > Math.max(Math.abs(b) * 0.02, 0.5);
  return (
    moved(published.kcal, current.kcal) ||
    moved(published.protein_g, current.protein_g) ||
    moved(published.carb_g, current.carb_g) ||
    moved(published.fat_g, current.fat_g)
  );
}

/**
 * What should the nightly job do with this cache row?
 *
 * Order is chosen so the recorded reason is the most useful one. Freshness, the
 * verification bar and the physics checks come first because a row failing any of
 * them is not a promotion candidate at all, whatever the catalog holds. Dedup runs
 * before any decision to write, which is what "dedup first" means: nothing reaches
 * `foods` without having been checked against what is already in `foods`.
 */
export function promotionDecision(
  cand: PromotionCandidate,
  catalog: CatalogRow[],
  now: Date = new Date(),
): PromotionDecision {
  if (!isFresh(cand.last_verified_at, now)) {
    // Already published rows are left alone rather than retracted: the number was
    // right when we published it, and pulling rows out from under people's logs
    // needs a human. The self-heal pass re-verifies instead.
    return { action: "skip", reason: "expired" };
  }

  const bar = meetsVerificationBar(cand.kcal, cand.evidence);
  if (!bar.verified) {
    return {
      action: "skip",
      reason: "unverified",
      detail: bar.agreeing.length ? `only ${bar.agreeing.join(", ")}` : "no independent source",
    };
  }

  const physics = failsPhysics(cand);
  if (physics) {
    return { action: "skip", reason: "implausible", detail: physics };
  }

  // Already published: this is the self-heal path, not a promotion.
  if (cand.promoted_food_id) {
    const published = catalog.find((r) => r.id === cand.promoted_food_id);
    if (!published) {
      // The row was deleted or merged under us. Do not silently re-insert it; a
      // human removed it for some reason.
      return { action: "skip", reason: "promoted-row-missing" };
    }
    const stale = !published.last_verified_at ||
      new Date(published.last_verified_at).getTime() < new Date(cand.last_verified_at).getTime();
    if (stale && macrosMoved(published, cand)) {
      return { action: "refresh", food_id: published.id, agreeing: bar.agreeing };
    }
    return { action: "skip", reason: "already-current" };
  }

  const dup = findDuplicate(cand, catalog);
  if (dup) {
    if (dup.conflict) {
      // Same food by name, different energy. Publishing ours would split the
      // ranking; overwriting theirs would let an unattended job rewrite curated
      // data on the strength of two web pages. Neither, and say why.
      return {
        action: "skip",
        reason: "catalog-conflict",
        detail: `${dup.row.name} (${dup.row.source}) has ${dup.row.kcal} kcal, we have ${cand.kcal}`,
      };
    }
    return { action: "link", food_id: dup.row.id };
  }

  return { action: "promote", agreeing: bar.agreeing };
}
