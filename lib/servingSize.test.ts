// Run with: deno test lib/servingSize.test.ts
//
// lib/servingSize.ts has no imports, so Deno can test it directly. The unit
// check is a copy of the two tables' keys in lib/units.ts.

import { assertEquals } from "jsr:@std/assert@1";
import { joinServing, splitServing } from "./servingSize.ts";

const UNITS = new Set(["g", "kg", "oz", "lb", "ml", "l", "cup", "tbsp", "tsp"]);
const isM = (u: string) => UNITS.has(u.trim().toLowerCase());

Deno.test("a gram line is one serving of its grams, not N servings of 1 g", () => {
  // The reported sheet: "15 g" of cheese sauce showed Quantity 15, Amount 15.
  assertEquals(splitServing(15, "g", isM), { size: 15, unit: "g", count: 1 });
});

Deno.test("a named serving splits into size, unit and count", () => {
  assertEquals(splitServing(2, "1 roti", isM), { size: 1, unit: "roti", count: 2 });
  assertEquals(splitServing(1.5, "100 g", isM), { size: 100, unit: "g", count: 1.5 });
  assertEquals(splitServing(1, "1/2 katori", isM), { size: 0.5, unit: "katori", count: 1 });
  assertEquals(splitServing(3, "slice", isM), { size: 1, unit: "slice", count: 3 });
});

Deno.test("an untouched line saves back exactly as it came in", () => {
  for (const [q, l] of [[15, "g"], [2, "1 roti"], [3, "slice"], [1, "0.50 cup"], [2, "cup"], [1, "medium (65 g)"]] as const) {
    const back = joinServing(splitServing(q, l, isM), { quantity: q, serving_label: l }, isM);
    assertEquals(back, { quantity: q, serving_label: l }, `${q} x ${l}`);
  }
});

Deno.test("a gram serving stays stored as grams", () => {
  const orig = { quantity: 15, serving_label: "g" };
  assertEquals(joinServing({ size: 100, unit: "g", count: 1.5 }, orig, isM), { quantity: 150, serving_label: "g" });
});

Deno.test("a new size or unit writes the size into the label", () => {
  const slice = { quantity: 1, serving_label: "slice" };
  assertEquals(joinServing({ size: 2, unit: "slice", count: 1 }, slice, isM), { quantity: 1, serving_label: "2 slice" });
  assertEquals(joinServing({ size: 1, unit: "tub", count: 2 }, slice, isM), { quantity: 2, serving_label: "tub" });
  const gram = { quantity: 15, serving_label: "g" };
  assertEquals(joinServing({ size: 1, unit: "tub", count: 1 }, gram, isM), { quantity: 1, serving_label: "1 tub" });
});
