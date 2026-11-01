// Eval set: does Precise find the printed label for a branded packet food, or
// fall back to an estimate with a made-up name?
//
// Run with CASE_SET=branded-oats (see run.ts). It runs Precise (mode "super")
// on the Tavily + Jev web lookup, the production path, and needs TAVILY_API_KEY
// and JEV_API_KEY. EVAL_WEB_IMAGES=1 turns on reading labels off the pages'
// pictures (PRECISE_WEB_IMAGES in production). Compare the summary's
// "estimate lines" with and without it.
//
// Branded oats, because that is where the live miss was (2026-10-18, "20g Too
// Yum protein masala oats": the right pages were found, the label was a
// picture, the line became an estimate). Brand sites and Amazon print these
// labels as images. The kcal band is what an oats product at the named amount
// can honestly be (about 330-430 kcal per 100 g dry), wide on purpose: it
// catches a wrong panel (per pack, per serving read as per 100 g, a different
// product), not a few kcal of label drift.
//
// HELD OUT. Nothing here may be copied into a prompt or a Jev question (see
// feedback: no eval-overfit prompts).

import type { EvalCase } from "./cases";

const per100 = (grams: number, lo = 330, hi = 430): [number, number] => [
  Math.round((grams * lo) / 100),
  Math.round((grams * hi) / 100),
];

const one = (id: string, text: string, grams: number, band?: [number, number]): EvalCase => ({
  id: `bo-${id}`,
  text,
  hour: 9,
  expect: {
    minItems: 1,
    maxItems: 1,
    items: [{ nameIncludes: "oat", kcalBetween: band ?? per100(grams) }],
  },
});

export const BRANDED_OATS_CASES: EvalCase[] = [
  // The live miss. Its label prints 366 kcal per 100 g.
  one("too-yumm-masala", "20g Too Yum protein masala oats", 20),
  one("yogabar-dark-choc", "40g Yoga Bar protein oats dark chocolate", 40),
  one("pintola-choc", "50g Pintola high protein oats chocolate", 50),
  one("saffola-classic-masala", "40g Saffola classic masala oats", 40),
  one("bagrrys-tangy", "40g Bagrry's tangy masala high protein oats", 40),
  one("goat-life-choco", "60g GOAT Life high protein overnight oats choco hazelnut", 60),
  one("true-elements-protein", "40g True Elements protein oats", 40),
  one("kelloggs-masala", "40g Kellogg's masala oats", 40),
  one("quaker-plain", "40g Quaker oats", 40),
  one("saffola-peppy-tomato", "40g Saffola peppy tomato oats", 40),
];
