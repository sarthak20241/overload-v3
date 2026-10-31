// Eval set: a branded food our catalog does not have. Is the line the user's
// brand (an honest estimate is fine), or another company's product or a plain
// generic row that only shares a word with it?
//
// Run with CASE_SET=branded-oats (see run.ts). From one user's live logs,
// 2026-09-29..10-30 (parse_traces): "doctors banana caramel oats" logged as
// rolled oats, "kesar pista oats" as Quaker cherry pistachio, "too yum protein
// oats" as Saffola Masala Oats, a protein paratha as plain paratha. The kcal
// band is the brand's own label at that weight, +-15%: a generic row or another
// brand is usually outside it, and forbidNames catches the ones that are not.
//
// No user memory here: this is the path a first log takes, before anything is
// saved. The harness runs Thorough (it has no Precise mode and no web lookup by
// default), which shares the catalog search, brand check and decide steps that
// produced these rows.
//
// HELD OUT. Nothing here may be copied into a prompt or a Jev question (see
// feedback: no eval-overfit prompts).

import type { EvalCase } from "./cases";

/** Rows that only share "oats" with a branded protein oats, or are another brand's. */
const NOT_THESE_OATS = [
  "rolled", "steel cut", "oat bran", "oats, raw", "saffola", "soulfull", "quaker", "real medleys",
  "oat bakes", "prozis", "premier protein", "myprotein",
];

const band = (kcal: number): [number, number] => [Math.round(kcal * 0.85), Math.round(kcal * 1.15)];

const one = (
  id: string,
  text: string,
  nameIncludes: string,
  labelKcal: number,
  forbid: string[],
  nameIncludesAny: string[] = [],
): EvalCase => ({
  id: `bo-${id}`,
  text,
  hour: 9,
  expect: {
    minItems: 1,
    maxItems: 1,
    items: [{ nameIncludes, nameIncludesAny, kcalBetween: band(labelKcal) }],
    forbidNames: forbid,
  },
});

export const BRANDED_OATS_CASES: EvalCase[] = [
  // Too Yumm High Protein Super Oats Masala: 365 kcal / 100 g on the pack.
  one("too-yum-20g", "20g too yum protein oats", "yum", 73, NOT_THESE_OATS),
  one("too-yum-masala", "37g too yumm high protein super oats masala", "yum", 135, NOT_THESE_OATS),
  // Doctor's Choice Banana Caramel Protein Oats: 426 kcal / 100 g.
  one("doctors-short", "7g doctors banana caramel oats", "banana caramel", 30, NOT_THESE_OATS, ["doctor"]),
  one("doctors-full", "33g doctor's choice banana caramel protein oats", "banana caramel", 141, NOT_THESE_OATS, ["doctor"]),
  // Yogabar High Protein Oats Kesar Pista Kulfi: 327 kcal / 100 g.
  one("yogabar-kesar", "30g yogabar kesar pista oats", "kesar", 98, [...NOT_THESE_OATS, "doctor"]),
  // No brand written: Yogabar and Doctor's Choice both sell it, so either
  // brand (or an estimate) is fine; another product is not. Band covers both.
  {
    id: "bo-kesar-nobrand",
    text: "57g kesar pista oats",
    hour: 9,
    expect: {
      minItems: 1,
      maxItems: 1,
      items: [{ nameIncludes: "kesar", kcalBetween: [Math.round(186 * 0.85), Math.round(215 * 1.15)] }],
      forbidNames: NOT_THESE_OATS,
    },
  },
  // Control: a brand the catalog has. Must keep working.
  one("pintola-choc", "50g pintola chocolate protein oats", "pintola", 196, ["yoga", "muscleblaze", "quaker", "rolled"]),
  // Not oats, same failure: Hello Tempayy Protein Bhara Paratha, 226.5 kcal / 100 g.
  one("tempayy-paratha", "Hello tempayy protein paratha 115g", "paratha", 260, ["plain paratha", "aloo", "gobi"], ["tempayy"]),

  // ── With her saved foods (needs JEV_API_KEY) ─────────────────────────────
  // Her real Oct 28 shortlist. Her own label must answer, at her numbers; a
  // line for another brand must never take it. These go through the memory
  // match and, between 0.6 and 0.7, decide's same-or-different judgement.
  withMemory(one("mem-too-yum", "10g too yum protein oats", "yumm", 36.5, NOT_THESE_OATS)),
  withMemory(one("mem-doctors", "7g doctors banana caramel oats", "banana caramel", 29.8, NOT_THESE_OATS, ["doctor"])),
  withMemory(one("mem-guard-saffola", "20g saffola masala oats", "saffola", 73, ["yumm", "pintola", "doctor", "muscleblaze"])),
  // Her only Yogabar oats is the kesar pista one: owner decision 2026-10-31 is
  // to show her most apt saved food, so a kept line teaches the alias.
  withMemory(one("mem-yogabar-protein", "30g yogabar protein oats", "kesar", 102, ["yumm", "pintola", "doctor", "muscleblaze"])),
  // 10-09..15 live: "kesar pista oats" with no brand missed her saved food three
  // times (saved brand-last, and "yogabar" reads as "yoga bar").
  withMemory(one("mem-kesar", "30g kesar pista oats", "yogabar", 102, NOT_THESE_OATS)),

  // A new food whose closest saved food is NOT it. With the decide bar at 0.3
  // these reach decide, which must say different and log the food she named.
  withSaved(one("new-peanut-chikki", "40g peanut chikki", "chikki", 200, ["peanuts", "peanut butter"]), [
    ["peanuts", 30, 170, 7.7, 4.8, 14.8], ["Pintola peanut butter", 16, 95, 4, 3, 8, "Pintola"], ["roasted chana", 20, 73, 4.5, 11, 1],
  ]),
  withSaved(one("new-apple-pie", "1 slice apple pie", "pie", 290, ["apple, raw"]), [
    ["apple", 170, 88, 0.5, 23, 0.3], ["Apple, raw", 130, 68, 0.3, 18, 0.2],
  ]),
  withSaved(one("new-masala-oats", "40g saffola masala oats", "saffola", 150, ["yumm"]), [
    ["Too Yumm! High Protein Super Oats - Masala", 37, 135, 8.2, 20, 2.6, "Too Yumm"], ["rolled oats", 30, 114, 4, 20, 2],
  ]),
  // The choice step (2026-10-31): her "Masala chai" for "masala tea" reaches
  // decide, which must take it; "chocolate milk" must not become Milk chocolate.
  // 1 cup is 200 ml: her 150 g at 70 kcal is 93 kcal for a cup.
  withSaved(one("mem-masala-tea", "1 cup masala tea", "chai", 93, ["powder"]), [
    ["Masala chai", 150, 70, 2.5, 9, 2.5], ["Tea masala powder", 5, 15, 0.5, 2.5, 0.3],
  ]),
  // Chocolate milk is 65-85 kcal / 100 ml (low fat to whole): 130-170 for 200 ml.
  withSaved(one("new-choc-milk", "200 ml chocolate milk", "milk", 150, ["milk chocolate", "dairy milk"]), [
    ["Milk chocolate", 20, 108, 1.5, 11.8, 6],
  ]),
];

/** These saved foods instead of hers. */
function withSaved(c: EvalCase, memory: NonNullable<EvalCase["memory"]>): EvalCase {
  return { ...c, memory };
}

/** Her saved foods on 2026-10-28, at the grams and numbers she logged them. */
function withMemory(c: EvalCase): EvalCase {
  return {
    ...c,
    memory: [
      ["Too Yumm! High Protein Super Oats - Masala", 37, 135, 8.2, 20, 2.6, "Too Yumm"],
      ["Too Yumm High Protein Super Oats Masala (estimate)", 20, 74, 4.4, 10.8, 1.4, "Too Yumm"],
      ["Pintola protein oats", 12, 47.2, 3.2, 6.6, 1.1, "Pintola"],
      ["Pintola chocolate protein oats", 20, 78.3, 5, 11, 1.6, "Pintola"],
      ["Muscleblaze Apple Cinnamon Protein Oats", 25, 90, 6.8, 13.5, 1.5, "MuscleBlaze"],
      ["MuscleBlaze Banana Strawberry Protein Oats", 27, 99, 7.3, 15.3, 1.7, "MuscleBlaze"],
      ["Doctor's Choice banana caramel protein oats", 33, 141, 7.9, 23, 1.9, "Doctor's Choice"],
      ["casein", 16, 60.1, 13, 1.5, 0.3],
      ["Kesar pista oats yogabar", 30, 102, 8.4, 13.5, 2, "Yogabar"],
    ],
  };
}
