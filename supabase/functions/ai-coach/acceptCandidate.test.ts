// Run with: deno test supabase/functions/ai-coach/acceptCandidate.test.ts
//
// Every REJECT here is a row that actually shipped to a user, confidently and
// without a warning. The gate exists to turn each of them into an estimate,
// because "near but uncertain" beats "precise about the wrong food".

import { assertEquals } from "jsr:@std/assert@1";
import { acceptCandidate, brandIsIdentity, coversUserWords, firstAcceptable } from "./acceptCandidate.ts";
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

Deno.test("a row listing several preps is not a clash, but a row-only part is", () => {
  // USDA writes "Egg, whole, boiled or poached". Comparing the user's "boiled"
  // against whichever listed term was longest rejected the right row - and the
  // gate then accepted the YOLK row instead, the original 347-vs-143 incident.
  assertEquals(ok("boiled egg", row("Egg, whole, boiled or poached")), true);
  assertEquals(why("boiled egg", row("Eggs, chicken, yolk, boiled", { kcal: 347 })), "form-mismatch");
  // Asking for yolk still gets yolk.
  assertEquals(ok("egg yolk", row("Eggs, chicken, yolk, boiled", { kcal: 347 })), true);
});


Deno.test("a branded row must not lose to one that simply omits the brand", () => {
  // Shipped on device: "1 amul cheese slice" logged as Cheese, provolone.
  // Extract splits brand from name, and the caller was building `said` from the
  // name alone, so "amul" was never required - and firstAcceptable then counted
  // the brand AGAINST the right row as an unexplained word (amul, a = 2) while
  // provolone carried only one (provolone = 1). The wrong row won BECAUSE it
  // was not the brand asked for.
  const cands = [
    row("Amul Cheese Slice A", { brand: "Amul", kcal: 316 }),
    row("Cheese, provolone, sliced", { kcal: 357 }),
  ];
  // Name only - the old behaviour. Provolone is accepted and preferred.
  assertEquals(ok("cheese slice", cands[1]), true);
  assertEquals(firstAcceptable("cheese slice", cands, guards)?.cand.name, "Cheese, provolone, sliced");

  // Brand included, as the caller now builds it. Provolone no longer covers.
  assertEquals(why("Amul cheese slice", cands[1]), "uncovered-word");
  assertEquals(firstAcceptable("Amul cheese slice", cands, guards)?.cand.name, "Amul Cheese Slice A");
});

Deno.test("brandIsIdentity: required for a recipe, droppable for a commodity", () => {
  // Fixed by standard or nature - Amul and Mother Dairy are the same food.
  assertEquals(brandIsIdentity("Amul", "toned milk"), false);
  assertEquals(brandIsIdentity("Amul", "ghee"), false);
  assertEquals(brandIsIdentity("Mother Dairy", "curd"), false);
  // Formulated - the recipe IS the product.
  assertEquals(brandIsIdentity("Amul", "cheese slice"), true);
  assertEquals(brandIsIdentity("Oreo", "biscuits"), true);
  assertEquals(brandIsIdentity("Quest", "protein bar"), true);
  // No brand named: nothing to require.
  assertEquals(brandIsIdentity(null, "cheese slice"), false);
});

Deno.test("a commodity brand does not lock out the generic row", () => {
  // The regression the brand fix could have caused: requiring "amul" here would
  // mean "Amul toned milk" never matches the curated Toned Milk row.
  assertEquals(brandIsIdentity("Amul", "toned milk"), false);
  assertEquals(ok("toned milk", row("Toned Milk", { kcal: 58 })), true);
});

// ── Live 2026-09-14, Quick mode ─────────────────────────────────────────────
// "chicken" logged Chicken feet, "toast" logged Melba toast. Both rows cover
// the user's word; both are a different food. The tie-break preferred them
// BECAUSE they were short: one unexplained word beat the two or three on the
// rows that were actually chicken or toast, and the LIKE search had already
// sorted by brevity, so the two biases compounded.

Deno.test("REJECTS a body part the user never named", () => {
  // Same blindness as yolk: the user who says "chicken" means the meat.
  assertEquals(why("chicken", row("Chicken feet", { kcal: 215 })), "form-mismatch");
  assertEquals(why("chicken", row("Chicken, tail", { kcal: 454 })), "form-mismatch");
  // Naming the part yourself is fine.
  assertEquals(ok("chicken feet", row("Chicken feet", { kcal: 215 })), true);
  assertEquals(ok("chicken liver", row("Chicken liver, cooked")), true);
});

Deno.test("a one-word food does not take a row that adds an identity word", () => {
  // Every row here is a chicken DISH or PART, not chicken. The honest answer
  // is the estimate, which null signals.
  assertEquals(
    firstAcceptable("chicken", [row("Chicken kiev"), row("Chicken Curry"), row("Chicken Keema")], guards),
    null,
  );
  assertEquals(
    firstAcceptable("toast", [row("Melba toast"), row("Shrimp toast"), row("Anisette toast")], guards),
    null,
  );
  assertEquals(
    firstAcceptable("rice", [row("Rice cake"), row("Rice milk"), row("Rice paper")], guards),
    null,
  );
});

Deno.test("descriptors of the SAME food are not identity words", () => {
  // Grade, prep state and NFS qualify a food without changing which food it is.
  assertEquals(firstAcceptable("milk", [row("Amul Taaza Toned Milk", { brand: "Amul" }), row("Toned Milk")], guards)?.cand.name, "Toned Milk");
  assertEquals(firstAcceptable("milk", [row("Milk, whole")], guards)?.cand.name, "Milk, whole");
  assertEquals(firstAcceptable("rice", [row("Rice cake"), row("Rice, cooked, NFS")], guards)?.cand.name, "Rice, cooked, NFS");
  assertEquals(firstAcceptable("beans", [row("Fava beans, cooked"), row("Beans, NFS")], guards)?.cand.name, "Beans, NFS");
  assertEquals(firstAcceptable("egg", [row("Egg, whole, raw"), row("Egg Curry")], guards)?.cand.name, "Egg, whole, raw");
  // A regional name on the row is the same word.
  assertEquals(firstAcceptable("curd", [row("Curd / Dahi")], guards)?.cand.name, "Curd / Dahi");
  // A brand on a commodity does not change the food either.
  assertEquals(firstAcceptable("paneer", [row("Milky Mist Paneer", { brand: "Milky Mist" })], guards)?.cand.name, "Milky Mist Paneer");
});

Deno.test("a multi-word phrase keeps tolerating a more specific row", () => {
  // The rule is for the bare one-word case, where "more specific" is usually
  // "a different food". A phrase already pins the identity.
  assertEquals(
    firstAcceptable("paneer bhurji", [row("Egg Bhurji"), row("Paneer Bhurji Masala")], guards)?.cand.name,
    "Paneer Bhurji Masala",
  );
  // And descriptors now break ties on phrases too: the row that is only MORE
  // described wins over the one that adds a word.
  assertEquals(
    firstAcceptable("boiled eggs", [row("Eggs, chicken, whole, boiled"), row("Egg, whole, boiled or poached")], guards)?.cand.name,
    "Egg, whole, boiled or poached",
  );
});
