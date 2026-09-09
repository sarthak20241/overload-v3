// How many foods one message may log.
//
// The ceiling was 12, a bare `.slice(0, 12)` at two points with no test. It
// outlived the assumption it was written under: a message used to be one meal,
// and full-day logging made it a day. A real day runs past twelve foods, so
// item thirteen onward was dropped in silence - the same failure as the old
// 500-character input cap, one step further down the pipeline.
//
// These tests pin the size and, more importantly, pin that a day-shaped list
// survives sanitizeItems whole.

import { assertEquals } from "jsr:@std/assert@1";
import { MAX_ITEMS_PER_PARSE, sanitizeItems } from "./parseMeal.ts";

/** A model-shaped item. Only food_name matters to the clamp; the rest is here
 *  so the rows are realistic rather than minimal. */
const row = (n: number) => ({
  food_name: `Food ${n}`,
  quantity: 1,
  serving_label: "serving",
  grams: 100,
  kcal: 100,
  protein_g: 5,
  carb_g: 10,
  fat_g: 3,
  source: "catalog",
  food_id: `f-${n}`,
});

/** Everything a real day holds, written out rather than counted, because the
 *  point of the test is that this is an ordinary day and not an edge case. */
const A_REAL_DAY = [
  "Toned Milk", "Boiled Eggs", "Brown Bread", "Butter", // breakfast
  "Banana", "Almonds", // mid morning
  "Roti", "Dal", "Jeera Rice", "Bhindi Sabzi", "Curd", "Onion Salad", // lunch
  "Milk Tea", "Marie Biscuits", "Whey Protein", // evening
  "Paneer Bhurji", "Roti", "Green Salad", // dinner
];

Deno.test("a real day survives whole", () => {
  // The regression. At 12 this lost the whey, the paneer and everything after
  // it, and said nothing about having done so.
  const raw = A_REAL_DAY.map((food_name, i) => ({ ...row(i), food_name }));
  const out = sanitizeItems(raw);
  assertEquals(out.length, A_REAL_DAY.length);
  assertEquals(out.map((i) => i.food_name), A_REAL_DAY);
  // Guard the fixture: if someone trims this list under the old ceiling it
  // would pass against 12 too and stop being a regression test.
  if (A_REAL_DAY.length <= 12) throw new Error("fixture must exceed the old 12 ceiling");
});

Deno.test("a short meal is untouched", () => {
  const out = sanitizeItems([row(1), row(2)]);
  assertEquals(out.length, 2);
});

Deno.test("exactly at the ceiling is kept, one over is clamped", () => {
  const at = sanitizeItems(Array.from({ length: MAX_ITEMS_PER_PARSE }, (_, i) => row(i)));
  assertEquals(at.length, MAX_ITEMS_PER_PARSE);

  const over = sanitizeItems(Array.from({ length: MAX_ITEMS_PER_PARSE + 5 }, (_, i) => row(i)));
  assertEquals(over.length, MAX_ITEMS_PER_PARSE);
  // It keeps the FIRST N, so what falls off is the end of the message. That is
  // the shape of the loss and it is why the ceiling has to be past a real day
  // rather than merely large.
  assertEquals(over[0].food_name, "Food 0");
  assertEquals(over[MAX_ITEMS_PER_PARSE - 1].food_name, `Food ${MAX_ITEMS_PER_PARSE - 1}`);
});

Deno.test("the ceiling is past a real day", () => {
  // Not a style assertion. 12 was chosen when a message was one meal, and the
  // bug was that nobody re-checked it when a message became one DAY. This
  // fails loudly if someone tightens it back under a day of food.
  if (MAX_ITEMS_PER_PARSE < A_REAL_DAY.length) {
    throw new Error(`ceiling ${MAX_ITEMS_PER_PARSE} is under a real day (${A_REAL_DAY.length} foods)`);
  }
});

Deno.test("the clamp does not paper over junk rows", () => {
  // Nameless and non-object entries are dropped on their own merits, and that
  // dropping happens INSIDE the window - so junk in the first 50 does not buy
  // a real food at position 51 a place. Worth pinning: it is the difference
  // between "keep 50 foods" and "look at 50 entries".
  const raw: unknown[] = [row(1), null, { food_name: "   " }, "nope", row(2)];
  assertEquals(sanitizeItems(raw).map((i) => i.food_name), ["Food 1", "Food 2"]);
});
