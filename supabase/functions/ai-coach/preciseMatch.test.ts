// Run with: deno test --allow-all supabase/functions/ai-coach/preciseMatch.test.ts
//
// The gate on Jev's "which of our rows is this food" answer. Jev judges; this
// code decides whether the judgement is served, so these rules are the last
// line between a confident pick and a wrong row on someone's diary.

import { assertEquals } from "jsr:@std/assert@1";
import type { JevChoiceAnswer } from "./jev.ts";
import {
  decideKind,
  decideMatch,
  decideMatchNoul,
  kindQuestion,
  matchQuestion,
  type MatchCandidate,
  mealState,
  sameBrand,
} from "./preciseMatch.ts";

const pick = (choice: string, confidence = 0.9): JevChoiceAnswer => ({
  type: "choice", choice, confidence, probabilities: { [choice]: confidence },
});

const USDA_BANANA: MatchCandidate = { id: "a", name: "Bananas, raw", brand: null, source: "usda" };
const OFF_BANANA_CHIPS: MatchCandidate = { id: "b", name: "Banana chips", brand: "Haldiram's", source: "off" };
const AMUL_SLICE: MatchCandidate = { id: "c", name: "Amul cheese slices", brand: "Amul", source: "off", kcal: 311, protein_g: 20 };
const AMUL_SLICE_2: MatchCandidate = { id: "c2", name: "Amul Cheese Slice A", brand: "Amul", source: "off", kcal: 316, protein_g: 20 };
const BRITANNIA_SLICE: MatchCandidate = { id: "d", name: "Cheese slices", brand: "Britannia", source: "off" };
const OFF_UNBRANDED: MatchCandidate = { id: "e", name: "Banana", brand: null, source: "off" };

Deno.test("a confident pick of a reference row answers a plain food", () => {
  const d = decideMatch("plain", { name: "banana", brand: null }, [USDA_BANANA, OFF_BANANA_CHIPS], pick("c1"));
  assertEquals(d.match?.id, "a");
});

Deno.test("below the floor is a miss, however right the pick looks", () => {
  const d = decideMatch("plain", { name: "banana", brand: null }, [USDA_BANANA], pick("c1", 0.7));
  assertEquals(d.match, null);
  assertEquals(d.match === null && d.reason, "below_floor");
});

Deno.test("none and no answer are misses", () => {
  assertEquals(decideMatch("plain", { name: "x", brand: null }, [USDA_BANANA], pick("none")).match, null);
  assertEquals(decideMatch("plain", { name: "x", brand: null }, [USDA_BANANA], null).match, null);
  assertEquals(decideMatch("plain", { name: "x", brand: null }, [USDA_BANANA], pick("c9")).match, null);
});

Deno.test("a plain food never takes a branded pack or a non-reference row", () => {
  const branded = decideMatch("plain", { name: "banana", brand: null }, [OFF_BANANA_CHIPS], pick("c1"));
  assertEquals(branded.match === null && branded.reason, "kind");
  const offRow = decideMatch("plain", { name: "banana", brand: null }, [OFF_UNBRANDED], pick("c1"));
  assertEquals(offRow.match === null && offRow.reason, "kind");
});

Deno.test("a branded line never takes another brand's row", () => {
  const d = decideMatch("packaged", { name: "cheese slice", brand: "Amul" }, [BRITANNIA_SLICE, AMUL_SLICE], pick("c1"));
  assertEquals(d.match === null && d.reason, "brand");
  const ok = decideMatch("packaged", { name: "cheese slice", brand: "Amul" }, [BRITANNIA_SLICE, AMUL_SLICE, AMUL_SLICE_2], pick("c2"));
  assertEquals(ok.match?.id, "c");
});

Deno.test("packaged needs a row of the same brand even when the line has none", () => {
  // "Pintola rice cake" with the brand inside the name, and a generic row.
  const generic: MatchCandidate = { id: "g", name: "Rice cakes, plain", brand: null, source: "usda" };
  const pintola: MatchCandidate = { id: "p", name: "Rice cake", brand: "Pintola", source: "precise", kcal: 384, protein_g: 9 };
  const item = { name: "Pintola rice cake", brand: null };
  assertEquals(decideMatch("packaged", item, [generic], pick("c1")).match, null);
  assertEquals(decideMatch("packaged", item, [pintola], pick("c1")).match?.id, "p");
});

Deno.test("sameBrand tolerates spelling and a brand inside the name", () => {
  assertEquals(sameBrand({ name: "x", brand: "Haldiram's" }, { id: "1", name: "y", brand: "Haldirams", source: "off" }), true);
  assertEquals(sameBrand({ name: "x", brand: "Amul" }, { id: "1", name: "y", brand: "Amul Dairy", source: "off" }), true);
  assertEquals(sameBrand({ name: "Kurkure masala munch", brand: null }, { id: "1", name: "y", brand: "Kurkure", source: "off" }), true);
  assertEquals(sameBrand({ name: "x", brand: "Amul" }, { id: "1", name: "y", brand: null, source: "off" }), false);
  // The brand inside the ROW's name: OFF files Maggi under Nestle, USDA chain rows have no brand.
  assertEquals(sameBrand({ name: "masala noodles", brand: "Maggi" }, { id: "1", name: "Nestle Maggi Masala Noodles", brand: "Nestle", source: "off" }), true);
  assertEquals(sameBrand({ name: "Whopper", brand: "Burger King" }, { id: "1", name: "Whopper (Burger King)", brand: null, source: "usda" }), true);
  assertEquals(sameBrand({ name: "masala noodles", brand: "Maggi" }, { id: "1", name: "Sunfeast Yippee noodles", brand: "Sunfeast", source: "off" }), false);
});

Deno.test("an unsure kind is no kind", () => {
  assertEquals(decideKind(pick("plain", 0.9)), "plain");
  assertEquals(decideKind(pick("plain", 0.5)), null);
  assertEquals(decideKind(pick("snack", 0.95)), null);
  assertEquals(decideKind(null), null);
});

Deno.test("questions name their food and list every candidate plus none", () => {
  const state = mealState([{ name: "banana", brand: null }, { name: "cheese slice", brand: "Amul" }]);
  assertEquals(state.foods.map((f) => f.id), ["f1", "f2"]);
  const kq = kindQuestion("f2");
  assertEquals(kq.type === "choice" && Object.keys(kq.criteria), ["plain", "packaged", "restaurant", "dish"]);
  const mq = matchQuestion("f2", "packaged", [BRITANNIA_SLICE, AMUL_SLICE]);
  assertEquals(mq.type === "choice" && Object.keys(mq.criteria), ["c1", "c2", "none"]);
  assertEquals(mq.type === "choice" && String(mq.instructions).includes('food f2 in "foods"'), true);
});

// ── Jev's confidence split across rows that are the same answer ─────────────

const split = (probs: Record<string, number>): JevChoiceAnswer => {
  const [choice, confidence] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  return { type: "choice", choice, confidence, probabilities: probs };
};

Deno.test("a split between rows with the same numbers adds up and is served", () => {
  const a: MatchCandidate = { id: "a", name: "Banana", brand: null, source: "web_verified", kcal: 89, protein_g: 1.1 };
  const b: MatchCandidate = { id: "b", name: "Banana, raw", brand: null, source: "usda", kcal: 97, protein_g: 0.7 };
  const d = decideMatch("plain", { name: "banana", brand: null }, [a, b], split({ c1: 0.41, c2: 0.44, none: 0.15 }));
  assertEquals(d.match?.id, "b");
  assertEquals(Math.round(d.confidence * 100), 85);
});

Deno.test("a split with a row whose numbers differ stays a miss", () => {
  const plain: MatchCandidate = { id: "p", name: "Rice, brown, cooked, no added fat", brand: null, source: "usda", kcal: 123, protein_g: 2.7 };
  const oily: MatchCandidate = { id: "o", name: "Rice, brown, cooked, fat added", brand: null, source: "usda", kcal: 141, protein_g: 2.7 };
  const d = decideMatch("plain", { name: "cooked brown rice", brand: null }, [plain, oily], split({ c1: 0.43, c2: 0.40, none: 0.17 }));
  assertEquals(d.match, null);
  assertEquals(d.match === null && d.reason, "below_floor");
});

Deno.test("same kcal but different protein is not the same answer", () => {
  const paneer: MatchCandidate = { id: "x", name: "Paneer", brand: null, source: "curated", kcal: 265, protein_g: 18 };
  const other: MatchCandidate = { id: "y", name: "Something", brand: null, source: "usda", kcal: 270, protein_g: 5 };
  const d = decideMatch("plain", { name: "paneer", brand: null }, [paneer, other], split({ c1: 0.5, c2: 0.4, none: 0.1 }));
  assertEquals(d.match, null);
});

Deno.test("a gated pick falls through to an equal row the gate allows", () => {
  const offCurd: MatchCandidate = { id: "off", name: "Curd", brand: null, source: "off", kcal: 62, protein_g: 3.1 };
  const curated: MatchCandidate = { id: "cur", name: "Curd / Dahi", brand: null, source: "curated", kcal: 60, protein_g: 3.1 };
  const d = decideMatch("plain", { name: "curd", brand: null }, [offCurd, curated], split({ c1: 0.84, c2: 0.1, none: 0.06 }));
  assertEquals(d.match?.id, "cur");
});

Deno.test("a lone crowd-sourced row is not served; a corroborated one is", () => {
  const perServing: MatchCandidate = { id: "l1", name: "Lay's classic salted chips", brand: "Lay's", source: "off", kcal: 100, protein_g: 1.3 };
  const real1: MatchCandidate = { id: "l2", name: "Lay's salted chips", brand: "Lay's", source: "off", kcal: 550, protein_g: 7 };
  const real2: MatchCandidate = { id: "l3", name: "Lay's salt chips", brand: "Lay's", source: "off", kcal: 549, protein_g: 6.1 };
  const item = { name: "Lay's classic salted chips", brand: "Lay's" };
  const lone = decideMatch("packaged", item, [perServing, real1, real2], split({ c1: 0.9, none: 0.1 }));
  assertEquals(lone.match === null && lone.reason, "uncorroborated");
  const agreed = decideMatch("packaged", item, [perServing, real1, real2], split({ c2: 0.85, none: 0.15 }));
  assertEquals(agreed.match?.id, "l2");
});

// ── Per-row yes/no form ─────────────────────────────────────────────────────

Deno.test("per-row: two right rows both score high and the highest is served", () => {
  const a: MatchCandidate = { id: "a", name: "Banana", brand: null, source: "web_verified", kcal: 89, protein_g: 1.1 };
  const b: MatchCandidate = { id: "b", name: "Banana, raw", brand: null, source: "usda", kcal: 97, protein_g: 0.7 };
  const d = decideMatchNoul("plain", { name: "banana", brand: null }, [a, b], [0.83, 0.79]);
  assertEquals(d.match?.id, "a");
});

Deno.test("per-row: a row with different numbers scoring close to the winner is contested", () => {
  const right: MatchCandidate = { id: "r", name: "Sweet potato, boiled, no added fat", brand: null, source: "usda", kcal: 82, protein_g: 1.4 };
  const fat: MatchCandidate = { id: "f", name: "Sweet potato, boiled, NS as to fat", brand: null, source: "usda", kcal: 115, protein_g: 1.4 };
  const d = decideMatchNoul("plain", { name: "boiled sweet potato", brand: null }, [right, fat], [0.93, 0.92]);
  assertEquals(d.match === null && d.reason, "contested");
  const clear = decideMatchNoul("plain", { name: "boiled sweet potato", brand: null }, [right, fat], [0.93, 0.5]);
  assertEquals(clear.match?.id, "r");
});

Deno.test("per-row: below the floor, gated rows and lone crowd rows are not served", () => {
  const usda: MatchCandidate = { id: "u", name: "Bananas, raw", brand: null, source: "usda", kcal: 89, protein_g: 1.1 };
  assertEquals(decideMatchNoul("plain", { name: "banana", brand: null }, [usda], [0.6]).match, null);
  const offOnly: MatchCandidate = { id: "o", name: "Banana", brand: null, source: "off", kcal: 89, protein_g: 1.1 };
  assertEquals(decideMatchNoul("plain", { name: "banana", brand: null }, [offOnly], [0.95]).match, null);
  const perServing: MatchCandidate = { id: "l1", name: "Lay's classic salted chips", brand: "Lay's", source: "off", kcal: 100, protein_g: 1.3 };
  const real: MatchCandidate = { id: "l2", name: "Lay's salted chips", brand: "Lay's", source: "off", kcal: 550, protein_g: 7 };
  const lone = decideMatchNoul("packaged", { name: "Lay's classic salted chips", brand: "Lay's" }, [perServing, real], [0.91, 0.43]);
  assertEquals(lone.match, null);
});
