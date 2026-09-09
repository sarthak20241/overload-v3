// The input cap on the user's own message.
//
// This existed as a bare `.slice(0, 500)` at two call sites with no test and
// no trace. Full-day logging made 500 too small, and because the cut was
// silent the failure looked like a bad parse rather than a missing half of
// the message. These tests pin BOTH halves: that a real full-day message
// survives whole, and that when the cap does bite the caller can tell.

import { assertEquals } from "jsr:@std/assert@1";
import { clampUserText, USER_TEXT_MAX_CHARS } from "./parseMeal.ts";

/** A day of food as someone actually types it, not as a test fixture: four
 *  meals, quantities, a couple of brands. This is the shape the old 500 cap
 *  cut in half. */
const FULL_DAY = [
  "for breakfast i had 3 boiled eggs and 2 slices of brown bread with about a",
  "teaspoon of amul butter on each, plus a glass of toned milk with my filter",
  "coffee, no sugar.",
  "mid morning around 11 i had one banana and roughly 10 almonds.",
  "lunch was 2 roti, one katori of arhar dal, half a plate of jeera rice, a",
  "katori of bhindi sabzi and a small bowl of homemade curd on the side, and a",
  "few slices of raw onion.",
  "in the evening i had a cup of milk tea with two marie biscuits, and after the",
  "gym one scoop of whey protein in water.",
  "dinner was paneer bhurji about 150 grams, 2 more roti, and a green salad with",
  "cucumber, tomato and onion with lemon squeezed on it, no dressing.",
  "before bed i had another small glass of toned milk with half a teaspoon of",
  "turmeric in it.",
].join(" ");

Deno.test("a full day of food survives whole", () => {
  // The regression. At 500 this message lost everything from the evening on,
  // and the model was asked to parse a day that ended at lunch.
  const { text, dropped } = clampUserText(FULL_DAY);
  assertEquals(dropped, 0);
  assertEquals(text, FULL_DAY);
  // Guard the fixture itself: if someone shortens it below the old cap this
  // test would pass against a 500 cap too and stop being a regression test.
  if (FULL_DAY.length <= 500) throw new Error("fixture must exceed the old 500 cap");
});

Deno.test("a short message is returned untouched", () => {
  const { text, dropped } = clampUserText("2 roti and dal");
  assertEquals(text, "2 roti and dal");
  assertEquals(dropped, 0);
});

Deno.test("trimming happens before measuring, so whitespace never costs words", () => {
  // A message exactly at the cap, wrapped in newlines the composer added.
  const body = "a".repeat(USER_TEXT_MAX_CHARS);
  const { text, dropped } = clampUserText(`\n  ${body}\t\n`);
  assertEquals(dropped, 0);
  assertEquals(text, body);
});

Deno.test("exactly at the cap is kept, one over is clamped", () => {
  const at = clampUserText("b".repeat(USER_TEXT_MAX_CHARS));
  assertEquals(at.dropped, 0);
  assertEquals(at.text.length, USER_TEXT_MAX_CHARS);

  const over = clampUserText("b".repeat(USER_TEXT_MAX_CHARS + 1));
  assertEquals(over.dropped, 1);
  assertEquals(over.text.length, USER_TEXT_MAX_CHARS);
});

Deno.test("a clamp reports how much it took, so it is never silent", () => {
  // The whole point of returning `dropped`: the call site pushes a
  // `user_text_clamped` trace step off it. A boolean would say that something
  // was lost; the count says how much, which is what tunes the cap.
  const { text, dropped } = clampUserText("c".repeat(USER_TEXT_MAX_CHARS + 750));
  assertEquals(dropped, 750);
  assertEquals(text.length, USER_TEXT_MAX_CHARS);
});

Deno.test("the cap is past any real message", () => {
  // Not a style assertion. 500 was chosen when a message was one meal, and
  // the bug was that nobody re-checked it when a message became one DAY.
  // This fails loudly if someone tightens it back under a day of food.
  if (USER_TEXT_MAX_CHARS < FULL_DAY.length) {
    throw new Error(`cap ${USER_TEXT_MAX_CHARS} is under a real day (${FULL_DAY.length} chars)`);
  }
});
