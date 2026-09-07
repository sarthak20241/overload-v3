// Run with: deno test supabase/functions/ai-coach/correctionScope.test.ts
//
// I1. The asymmetry is the whole design: calling a CHANGED line unchanged
// silently discards the user's edit, while calling an unchanged line changed
// merely costs a re-resolve. Every ambiguous case below must therefore come
// back null (= re-resolve), not a match.

import { assertEquals } from "jsr:@std/assert@1";
import { unchangedInCorrection, type ExtractedItem, type PreviousItem } from "./parseMeal.ts";

const prev = (name: string, quantity: number, serving_label: string): PreviousItem => ({
  food_id: "id-" + name,
  food_name: name,
  quantity,
  serving_label,
  grams: 100,
  kcal: 200,
  protein_g: 10,
  carb_g: 5,
  fat_g: 8,
  fiber_g: null,
  source: "catalog",
  assumption: null,
  confidence: "high",
});

const ext = (o: Partial<ExtractedItem> & { name: string }): ExtractedItem => ({
  brand: null,
  quantity: 1,
  unit: "serving",
  prep: null,
  correctsFoodName: null,
  ...o,
});

const DAL = prev("Dal", 1, "katori");
const ROTI = prev("Roti / Chapati", 2, "roti");

Deno.test("an untouched line is recognised and passed through", () => {
  const same = unchangedInCorrection(ext({ name: "Dal", quantity: 1, unit: "katori" }), [DAL, ROTI]);
  assertEquals(same?.food_name, "Dal");
});

Deno.test("plural units still count as the same unit", () => {
  assertEquals(
    unchangedInCorrection(ext({ name: "Roti / Chapati", quantity: 2, unit: "rotis" }), [ROTI])?.food_name,
    "Roti / Chapati",
  );
});

Deno.test("a changed AMOUNT must re-resolve, and says so with its tag", () => {
  // "make the roti 3" - the whole point of the turn. The tag is what marks it.
  assertEquals(
    unchangedInCorrection(
      ext({ name: "Roti / Chapati", quantity: 3, unit: "roti", correctsFoodName: "Roti / Chapati" }),
      [ROTI],
    ),
    null,
  );
});

Deno.test("a changed UNIT must re-resolve, and says so with its tag", () => {
  assertEquals(
    unchangedInCorrection(ext({ name: "Dal", quantity: 1, unit: "bowl", correctsFoodName: "Dal" }), [DAL]),
    null,
  );
});

Deno.test("THE ACCEPTED RISK: an unflagged line is passed through even if it moved", () => {
  // The cost of letting the model's own flags decide, pinned so nobody
  // discovers it by surprise. A line the model edits but leaves is_changed
  // false on is handed back untouched and the edit is silently dropped.
  // scopeCorrection records the contradiction so it shows up in a trace rather
  // than only in a user's day.
  const same = unchangedInCorrection(
    ext({ name: "Roti / Chapati", quantity: 3, unit: "roti", correctsFoodName: null }),
    [ROTI],
  );
  assertEquals(same?.food_name, "Roti / Chapati", "obeys the tag");
  const out = scopeCorrection(
    [ext({ name: "Roti / Chapati", quantity: 3, unit: "roti", correctsFoodName: null })],
    [ROTI],
    new Set<string>(),
  );
  assertEquals(out.contradictions.length, 1, "and writes it down");
  assertEquals(out.contradictions[0].includes("flagged untouched"), true, out.contradictions[0]);
});

Deno.test("a newly stated prep is a change", () => {
  // "make the egg boiled" must not be waved through as identical.
  const egg = prev("Egg", 2, "piece");
  assertEquals(unchangedInCorrection(ext({ name: "Egg", quantity: 2, unit: "piece", prep: "boiled" }), [egg]), null);
});

Deno.test("a food not in the previous meal is new, never a passthrough", () => {
  assertEquals(unchangedInCorrection(ext({ name: "Dosa", quantity: 1, unit: "serving" }), [DAL, ROTI]), null);
});

Deno.test("a re-target uses corrects_food_name and is NOT unchanged", () => {
  // "actually paneer not tofu": same amount, different food.
  const tofu = prev("Tofu", 50, "g");
  const item = ext({ name: "Paneer", quantity: 50, unit: "g", correctsFoodName: "Tofu" });
  assertEquals(unchangedInCorrection(item, [tofu]), null);
});

Deno.test("a duplicate name does not hide the matching line", () => {
  // Two chai entries differing only in size. The 150 g one is SECOND, so a scan
  // that stops at the first same-named line would call an unchanged line
  // changed. Flagged in review of PR #121.
  const chaiSmall = prev("Chai / Milk Tea", 75, "ml");
  const chaiBig = prev("Chai / Milk Tea", 150, "ml");
  assertEquals(
    unchangedInCorrection(
      ext({ name: "Chai / Milk Tea", quantity: 150, unit: "ml" }),
      [chaiSmall, chaiBig],
    )?.quantity,
    150,
  );
  // And the first one is still found when IT is the match.
  assertEquals(
    unchangedInCorrection(
      ext({ name: "Chai / Milk Tea", quantity: 75, unit: "ml" }),
      [chaiSmall, chaiBig],
    )?.quantity,
    75,
  );
  // A size matching neither is still a change.
  assertEquals(
    unchangedInCorrection(
      ext({ name: "Chai / Milk Tea", quantity: 200, unit: "ml" }),
      [chaiSmall, chaiBig],
    ),
    null,
  );
});

// ── Un-replacing is a contract, not part of the optimisation ────────────────
//
// The bug these pin, found on device against v154. A correction names every
// line it restates as the thing it "corrects", so an UNTOUCHED line ends up in
// replacedNames naming itself. A replaced name is treated as deliberately gone,
// so keepUncoveredPrevious will not restore it if decide omits the line.
//
// Un-marking used to live inside the resolve-narrowing branch, which is skipped
// when every line looks unchanged. So in exactly that case the line stayed
// marked, decide dropped it, and the restore guard refused to bring it back.
// Logging a three-meal day and then saying "make it 2 plates of rajma chawal"
// came back with two items: the poha silently gone, with its whole Breakfast
// section, though the user never mentioned poha.

import { scopeCorrection } from "./parseMeal.ts";

const POHA = prev("Poha", 1, "plate");
const RAJMA = prev("Rajma Chawal", 1, "plate");

Deno.test("a SELF-tag is an edit, not a replacement", () => {
  // "Poha" tagged "Poha" means that line was edited and is still on the card.
  // Marking it replaced tells the no-drop guard not to restore it if decide
  // omits it, which is exactly the deletion this whole thread started from.
  // Only a tag naming a DIFFERENT line is a replacement.
  const replaced = new Set<string>();
  scopeCorrection(
    [ext({ name: "Poha", quantity: 2, unit: "plate", correctsFoodName: "Poha" })],
    [POHA],
    replaced,
  );
  assertEquals(replaced.size, 0, "an edited line must stay restorable");
});

Deno.test("an over-tagging model cannot disable the no-drop guard", () => {
  // Observed: the same model tagged every line on one run and only the edited
  // line on the next. Under a name-blind rule the first run would mark every
  // line replaced and switch the guard off for the whole meal.
  const replaced = new Set<string>();
  scopeCorrection(
    [
      ext({ name: "Poha", quantity: 1, unit: "plate", correctsFoodName: "Poha" }),
      ext({ name: "Rajma Chawal", quantity: 2, unit: "plate", correctsFoodName: "Rajma Chawal" }),
    ],
    [POHA, RAJMA],
    replaced,
  );
  assertEquals(replaced.size, 0);
});

Deno.test("no previous match means nothing is un-marked", () => {
  const replaced = new Set(["poha"]);
  const out = scopeCorrection([ext({ name: "Idli", quantity: 2, unit: "piece" })], [POHA], replaced);
  assertEquals(replaced.has("poha"), true);
  assertEquals(out.untouched, 0);
});

// ── The prompt now asks for a tag ONLY on lines that change ─────────────────
//
// EXTRACT_CORRECTION_RULES used to say "copy each line's food_name into
// corrects_food_name, unchanged lines included". It now says the opposite for
// untouched lines: null. Sarthak's point, and it is the safer shape - the field
// then means one thing (this REPLACES that) instead of doubling as an identity
// label that the restore guard reads as "deliberately deleted".
//
// Observed both shapes from the same model on the same input, so the code has
// to keep handling both. These pin that.

Deno.test("an untouched line with NO tag is still recognised as unchanged", () => {
  // The new shape. Nothing lands in replacedNames at all, so there is nothing
  // to un-mark and the restore guard can always bring the line back.
  const replaced = new Set<string>();
  const out = scopeCorrection(
    [
      ext({ name: "Poha", quantity: 1, unit: "plate", correctsFoodName: null }),
      ext({ name: "Rajma Chawal", quantity: 2, unit: "plate", correctsFoodName: "Rajma Chawal" }),
    ],
    [POHA, RAJMA],
    replaced,
  );
  assertEquals(out.unchangedCount, 1, "the untagged line still matches by name, amount and unit");
  assertEquals(out.toResolve.map((i) => i.name), ["Rajma Chawal"]);
  assertEquals(replaced.size, 0);
});

Deno.test("a SWAP keeps its tag, and the swapped-out line stays replaced", () => {
  // The one case that must still carry a tag. "actually muesli not corn flakes"
  // names a line whose name is NOT its own; without it the app would restore
  // the corn flakes and log both.
  const CORN = prev("Corn Flakes", 1, "bowl");
  const replaced = new Set(["corn flakes"]);
  const out = scopeCorrection(
    [ext({ name: "Muesli", quantity: 1, unit: "bowl", correctsFoodName: "Corn Flakes" })],
    [CORN],
    replaced,
  );
  assertEquals(out.unchangedCount, 0, "a re-target is a change, however tidy it looks");
  assertEquals(replaced.has("corn flakes"), true, "the swapped-out line must not be resurrected");
});

// ── The two fields are separate, and mean opposite things ───────────────────
//
// Sarthak's split. corrects_food_name is SWAPS ONLY ("rice, not poha"), and
// is_changed is an EDIT to the line that is already there. They need opposite
// handling: a swapped line is gone and must not be restored, an edited line is
// still on the card and must stay restorable. One field doing both is what
// deleted a breakfast.

Deno.test("is_changed marks an EDIT, and the line stays restorable", () => {
  const replaced = new Set<string>();
  const out = scopeCorrection(
    [ext({ name: "Poha", quantity: 2, unit: "plate", isChanged: true })],
    [POHA],
    replaced,
  );
  assertEquals(out.unchangedCount, 0, "an edit is a change");
  assertEquals(replaced.size, 0, "an edited line must never read as deleted");
});

Deno.test("corrects_food_name marks a SWAP, and the old line stays gone", () => {
  const CORN = prev("Corn Flakes", 1, "bowl");
  const replaced = new Set(["corn flakes"]);
  const out = scopeCorrection(
    [ext({ name: "Muesli", quantity: 1, unit: "bowl", correctsFoodName: "Corn Flakes" })],
    [CORN],
    replaced,
  );
  assertEquals(out.unchangedCount, 0);
  assertEquals(replaced.has("corn flakes"), true, "the swapped-out food must not be resurrected");
});

Deno.test("neither flag means copied back untouched", () => {
  const replaced = new Set<string>();
  const out = scopeCorrection(
    [
      ext({ name: "Poha", quantity: 1, unit: "plate" }),
      ext({ name: "Rajma Chawal", quantity: 2, unit: "plate", isChanged: true }),
    ],
    [POHA, RAJMA],
    replaced,
  );
  assertEquals(out.unchangedCount, 1);
  assertEquals(out.toResolve.map((i) => i.name), ["Rajma Chawal"]);
  assertEquals(replaced.size, 0);
});
