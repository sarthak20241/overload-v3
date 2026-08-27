// Run with: deno test supabase/functions/ai-coach/gradeStock.test.ts
//
// I11. The live failure this exists to stop, from a real trace 2026-08-22:
// "50g milky mist low fat paneer" logged against the plain Milky Mist Paneer
// row - 283 kcal/100 g for a product that is 190. Nothing contradicted, the row
// was simply silent about being full fat, so every downstream guard passed it.

import { assertEquals } from "jsr:@std/assert@1";
import { gradeNotStocked, type CandidateFood } from "./parseMeal.ts";

const cand = (name: string): CandidateFood => ({
  food_id: "id-" + name,
  name,
  brand: null,
  base_unit: "g",
  kcal: 265,
  protein_g: 18,
  carb_g: 2,
  fat_g: 20,
  fiber_g: null,
  servings: [],
  source: "catalog",
});

Deno.test("the real regression: no candidate stocks 'low fat'", () => {
  assertEquals(
    gradeNotStocked("low fat paneer", [cand("Milky Mist Paneer"), cand("Paneer")]),
    "low fat",
  );
});

Deno.test("one honouring candidate is enough to stay grounded", () => {
  // decide can still pick that row, so we must NOT push it to estimate.
  assertEquals(
    gradeNotStocked("low fat paneer", [cand("Paneer"), cand("Low Fat Paneer, Milky Mist")]),
    null,
  );
});

Deno.test("double toned is not satisfied by a toned row", () => {
  // Longest-first matching: "double toned" must not read as "toned".
  assertEquals(
    gradeNotStocked("double toned milk", [cand("Amul Taaza Toned Milk"), cand("Toned Milk")]),
    "double toned",
  );
});

Deno.test("the miss is caught in BOTH directions", () => {
  // Asking for the weaker grade and being offered the stronger one is equally
  // wrong: toned is 58 kcal/100 ml, double toned 42.
  assertEquals(
    gradeNotStocked("toned milk", [cand("Amul Double Toned Milk")]),
    "toned",
  );
  assertEquals(
    gradeNotStocked("toned milk", [cand("Amul Taaza Toned Milk")]),
    null,
  );
});

Deno.test("no grade named means nothing to enforce", () => {
  assertEquals(gradeNotStocked("paneer", [cand("Milky Mist Paneer")]), null);
  assertEquals(gradeNotStocked("milk", [cand("Toned Milk")]), null);
});

Deno.test("empty candidate list is not a grade problem", () => {
  // Nothing resolved at all is the ordinary estimate path, not this one.
  assertEquals(gradeNotStocked("low fat paneer", []), null);
});

Deno.test("high protein is enforced the same way", () => {
  assertEquals(
    gradeNotStocked("high protein paneer", [cand("Paneer"), cand("Milky Mist Paneer")]),
    "high protein",
  );
  assertEquals(
    gradeNotStocked("high protein paneer", [cand("High Protein Paneer")]),
    null,
  );
});
