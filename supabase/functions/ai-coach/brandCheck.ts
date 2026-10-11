// Brand check: a catalog row from ANOTHER brand never answers for a food the
// user named by brand.
//
// The decide prompt already says so ("brand on a FORMULATED product ... IS the
// product"), and it was not enough. Seen live 2026-10-11 (parse_traces 709a7c27):
// every source missed a branded protein bar, a plain-name search for the bar's
// flavour returned another company's bar, and decide logged it with "close
// match" in the note. A rule the model may skip is not a guard.
//
// Why Jev and not a string test: people shorten brands and shops spell them
// several ways (one word or two, initials, a parent name). A word match would
// drop the user's OWN brand under another spelling, which is worse than the bug.
// Jev judges "different brand?" per row; code only decides which rows to ask
// about and where the floor sits.
//
// Runtime-agnostic, like jev.ts: no Deno globals.

import { askJev, asNoul, type JevDeps, type JevQuestion } from "./jev.ts";

export interface BrandRow {
  name: string;
  brand: string | null;
}

/** Jev's "this row is a different brand" must reach this before a row is
 *  dropped. High on purpose: a wrongly dropped row costs a good match, a wrongly
 *  kept one is what the decide prompt still guards against. */
export const OTHER_BRAND_FLOOR = 0.8;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Rows already written under the user's brand, in any spacing or case, need
 *  no question. A row's own brand field is what it is sold under, so when it
 *  has one only that is compared ("OtherCo" selling "Fitzo-style bars" is still
 *  asked about); the name stands in only for a row with no brand. Everything
 *  else goes to Jev, unbranded rows included: Jev says they are not ANOTHER
 *  brand, and they stay. */
export function rowsToAsk(brand: string, rows: BrandRow[]): number[] {
  const b = squash(brand);
  if (b.length < 2) return [];
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (!squash(r.brand?.trim() ? r.brand : r.name).includes(b)) out.push(i);
  });
  return out;
}

export function brandQuestions(ids: string[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const id of ids) {
    out[id] = {
      type: "noul",
      instructions:
        `Is row ${id} sold by a DIFFERENT company than the brand the user named in "food"? ` +
        "The same brand written another way (spaced or joined, short form, initials, its parent company) is " +
        "NOT different. A row with no brand at all, or a plain generic food, is NOT different either.",
      criteria: {
        true: "The row is another company's product.",
        false: "The row is the user's brand, or has no brand.",
      },
    };
  }
  return out;
}

export interface BrandCheck {
  /** Indexes of rows to drop: another company's product. */
  drop: number[];
  trace: Record<string, unknown>;
}

/**
 * Which rows are another brand's product. Never throws; any Jev failure drops
 * nothing (the decide prompt's rule is still there behind it).
 */
export async function otherBrandRows(
  jev: JevDeps,
  food: { name: string; brand: string },
  rows: BrandRow[],
): Promise<BrandCheck> {
  const ask = rowsToAsk(food.brand, rows);
  if (ask.length === 0) return { drop: [], trace: { asked: 0 } };
  const ids = ask.map((_, k) => `r${k + 1}`);
  const state = {
    food: { name: food.name, brand: food.brand },
    rows: ask.map((i, k) => ({ id: ids[k], name: rows[i].name, ...(rows[i].brand ? { brand: rows[i].brand } : {}) })),
  };
  const res = await askJev(state, brandQuestions(ids), jev).catch(() => null);
  if (!res || !res.ok) return { drop: [], trace: { asked: ask.length, failure: res && !res.ok ? res.failure : "threw" } };
  const drop: number[] = [];
  const answers: Array<{ name: string; other: number | null }> = [];
  ask.forEach((i, k) => {
    const p = asNoul(res.response.answers[ids[k]]);
    answers.push({ name: rows[i].name.slice(0, 60), other: p === null ? null : Math.round(p * 100) / 100 });
    if (p !== null && p >= OTHER_BRAND_FLOOR) drop.push(i);
  });
  return { drop, trace: { asked: ask.length, floor: OTHER_BRAND_FLOOR, answers } };
}
