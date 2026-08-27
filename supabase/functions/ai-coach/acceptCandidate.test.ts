// Run with: deno test supabase/functions/ai-coach/acceptCandidate.test.ts
//
// Every REJECT here is a row that actually shipped to a user, confidently and
// without a warning. The gate exists to turn each of them into an estimate,
// because "near but uncertain" beats "precise about the wrong food".

import { assertEquals } from "jsr:@std/assert@1";
import { acceptCandidate, coversUserWords, firstAcceptable } from "./acceptCandidate.ts";
import { implausiblePer100, unhonouredGrade, variantClash, type CandidateFood } from "./parseMeal.ts";

const guards = { variantClash, unhonouredGrade, implausiblePer100 };

const row = (name: string, o: Partial<CandidateFood> = {}): CandidateFood => ({
  food_id: "id", name, brand: null, base_unit: "g",
  kcal: 200, protein_g: 10, carb_g: 20, fat_g: 8, fiber_g: null,
  servings: [], source: "catalog", ...o,
});

const ok = (said: string, r: CandidateFood) => acceptCandidate(said, r, guards).ok;
const why = (said: string, r: CandidateFood) => acceptCandidate(said, r, guards).reason;

Deno.test("REJECTS the rows that actually shipped wrong", () => {
  // 609 kcal fried snack logged for a paneer dish.
  assertEquals(ok("paneer bhurji", row("Bhujia", { kcal: 609 })), false);
  assertEquals(why("paneer bhurji", row("Bhujia", { kcal: 609 })), "uncovered-word");

  // A coffee shop drink logged for a plate of chole bhature.
  assertEquals(ok("chole bhature", row("Starbucks signature chocolat")), false);

  // Right brand, wrong product.
  assertEquals(ok("mcaloo tikki", row("McDonald's Cheeseburger")), false);
});

Deno.test("REJECTS a grade the row does not stock", () => {
  // 283 kcal full-fat row for a 190 kcal product.
  assertEquals(why("low fat paneer", row("Milky Mist Paneer", { kcal: 283 })), "grade-not-honoured");
  assertEquals(why("double toned milk", row("Amul Taaza Toned Milk", { kcal: 58 })), "variant-clash");
});

Deno.test("REJECTS a contradicting variant", () => {
  // The original report: yolk macros under a whole-egg label.
  assertEquals(why("whole eggs", row("Eggs, chicken, yolk, raw", { kcal: 347 })), "variant-clash");
});

Deno.test("ACCEPTS when the row is merely MORE specific than the user", () => {
  // A person names food loosely; the catalog names it precisely. That is normal
  // and must not be punished.
  assertEquals(ok("milk", row("Amul Taaza Toned Milk")), true);
  assertEquals(ok("paneer", row("Milky Mist Paneer")), true);
  assertEquals(ok("eggs", row("Egg, whole, raw, fresh")), true);
  assertEquals(ok("dal", row("Dal")), true);
});

Deno.test("ACCEPTS through typos and regional names", () => {
  assertEquals(ok("panner", row("Paneer")), true);          // commonest Indian typo
  assertEquals(ok("doodh", row("Milk, whole")), true);      // hindi
  assertEquals(ok("dahi", row("Curd / Dahi")), true);
});

Deno.test("provenance words never decide identity", () => {
  // "fresh"/"homemade" describe where it came from, not what it is.
  assertEquals(ok("fresh homemade curd", row("Curd / Dahi")), true);
});

Deno.test("REJECTS a physically impossible row whatever its name", () => {
  // implausiblePer100 checks PHYSICS, not internal consistency: macros heavier
  // than the food, or calories above pure fat. Internal disagreement between
  // kcal and macros is checkAtwater's job, downstream.
  assertEquals(ok("paneer", row("Paneer", { protein_g: 60, carb_g: 60, fat_g: 40 })), false);
  assertEquals(why("paneer", row("Paneer", { kcal: 2000 })), "implausible");
});

Deno.test("firstAcceptable walks past the bad rows to a good one", () => {
  const cands = [
    row("Bhujia", { kcal: 609 }),
    row("Egg Bhurji"),
    row("Paneer Bhurji"),
  ];
  assertEquals(firstAcceptable("paneer bhurji", cands, guards)?.cand.name, "Paneer Bhurji");
  // And returns null when NOTHING covers it, which is the signal to estimate.
  assertEquals(firstAcceptable("paneer bhurji", cands.slice(0, 2), guards), null);
});

Deno.test("coversUserWords is directional", () => {
  assertEquals(coversUserWords("milk", "Toned Milk"), true);   // row more specific: fine
  assertEquals(coversUserWords("toned milk", "Milk"), false);  // row less specific: not fine
});

Deno.test("REJECTS a form change hiding behind full coverage", () => {
  // Found live on the fast path: every user word covered, and the row's EXTRA
  // word was doing all the damage - powder is 714 kcal where milk is ~35.
  assertEquals(why("amul skimmed milk", row("Amul Sagar Skimmed Milk Powder", { kcal: 714 })), "form-mismatch");
  assertEquals(why("banana", row("Banana chips", { kcal: 519 })), "form-mismatch");
  // But saying the form word yourself is fine.
  assertEquals(ok("milk powder", row("Amul Sagar Skimmed Milk Powder", { kcal: 714 })), true);
});
