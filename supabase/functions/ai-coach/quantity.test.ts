// Run with: deno test supabase/functions/ai-coach/quantity.test.ts
//
// The I7 class: a tool schema is ADVISORY, so "type: number" does not stop the
// model sending a quoted number. The old guard checked typeof === "number" and
// fell back to 1, which turned "250ml milk" into 1 ml with no error anywhere.

import { assertEquals } from "jsr:@std/assert@1";
import { coerceQuantity } from "./parseMeal.ts";

Deno.test("plain numbers pass through", () => {
  assertEquals(coerceQuantity(250), 250);
  assertEquals(coerceQuantity(2), 2);
  assertEquals(coerceQuantity(0.5), 0.5);
});

Deno.test("numeric strings are read, not silently turned into 1", () => {
  // This is the whole bug: every one of these used to come out as 1.
  assertEquals(coerceQuantity("250"), 250);
  assertEquals(coerceQuantity(" 300 "), 300);
  assertEquals(coerceQuantity("1.5"), 1.5);
});

Deno.test("junk still falls back to 1", () => {
  assertEquals(coerceQuantity(undefined), 1);
  assertEquals(coerceQuantity(null), 1);
  assertEquals(coerceQuantity("a bowl"), 1);
  assertEquals(coerceQuantity({}), 1);
  // Number("") is 0, which would wipe the line out. Must not be treated as 0.
  assertEquals(coerceQuantity(""), 1);
  assertEquals(coerceQuantity("   "), 1);
});

Deno.test("non-positive and non-finite fall back to 1", () => {
  assertEquals(coerceQuantity(0), 1);
  assertEquals(coerceQuantity(-5), 1);
  assertEquals(coerceQuantity("-250"), 1);
  assertEquals(coerceQuantity(Infinity), 1);
  assertEquals(coerceQuantity(NaN), 1);
});

Deno.test("absurd amounts are capped, not rejected", () => {
  // The cap exists to stop nonsense reaching the model, not to truncate real
  // masses - 500 ml and 250 g must survive intact.
  assertEquals(coerceQuantity(999999), 10000);
  assertEquals(coerceQuantity("999999"), 10000);
  assertEquals(coerceQuantity(500), 500);
});
