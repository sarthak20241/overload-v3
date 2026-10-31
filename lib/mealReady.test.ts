// Run with: deno test lib/mealReady.test.ts
//
// lib/mealReady.ts has no imports, so Deno can test it directly.

import { assertEquals } from "jsr:@std/assert@1";
import {
  arrivalAction,
  packReady,
  READY_MAX_AGE_MS,
  readyAction,
  readyLine,
  scaleLine,
  stepAmount,
  unpackReady,
} from "./mealReady.ts";

const watching = { sheetOpen: true, resultOpen: false, screenFocused: true, appActive: true };

Deno.test("a parse that lands while the sheet is up opens the result", () => {
  assertEquals(arrivalAction(watching), "show");
});

Deno.test("a correction landing on the open result stays on it", () => {
  assertEquals(arrivalAction({ ...watching, sheetOpen: false, resultOpen: true }), "show");
});

Deno.test("closing the sheet means not now: a toast, not a jump", () => {
  assertEquals(arrivalAction({ ...watching, sheetOpen: false }), "tell");
});

Deno.test("on another tab the user is told, even if the sheet state says open", () => {
  assertEquals(arrivalAction({ ...watching, screenFocused: false }), "tell");
});

Deno.test("with the app in the background the toast waits for the return", () => {
  assertEquals(arrivalAction({ ...watching, appActive: false }), "tell_later");
  assertEquals(arrivalAction({ ...watching, appActive: false, screenFocused: false }), "tell_later");
});

Deno.test("the toast names the meal, or says meals for a whole day", () => {
  assertEquals(readyLine("review", ["lunch"]), "Your lunch is ready to check.");
  assertEquals(readyLine("review", ["snack", "snack"]), "Your snack is ready to check.");
  assertEquals(readyLine("review", ["breakfast", "lunch"]), "Your meals are ready to check.");
  assertEquals(readyLine("logged", ["dinner"]), "Your dinner is in your diary.");
  assertEquals(readyLine("reply", []), "Drona has a question about your food.");
  assertEquals(readyAction("review"), "Check");
  assertEquals(readyAction("error"), "Open");
});

Deno.test("no toast line uses an em dash", () => {
  for (const k of ["review", "logged", "reply", "error"] as const) {
    assertEquals(readyLine(k, ["lunch"]).includes("—"), false);
  }
});

const review = {
  status: "review" as const,
  raw: "2 eggs and toast",
  meal: { items: [{ food_name: "egg" }], meal_type: "breakfast", drona_line: "Solid start." },
  mealType: "breakfast",
  dayIso: "2026-10-31",
};

Deno.test("a waiting result comes back after a restart", () => {
  const T = 1_000_000_000;
  assertEquals(unpackReady(packReady(review, T), T + 60_000), review);
});

Deno.test("a day-old result is dropped", () => {
  const T = 1_000_000_000;
  assertEquals(unpackReady(packReady(review, T), T + READY_MAX_AGE_MS + 1), null);
});

Deno.test("anything that is not a whole result is dropped, never thrown", () => {
  const T = 1_000_000_000;
  assertEquals(unpackReady(null, T), null);
  assertEquals(unpackReady("not json", T), null);
  assertEquals(unpackReady(JSON.stringify({ v: 1, at: T, flow: { status: "idle" } }), T), null);
  assertEquals(unpackReady(packReady({ ...review, meal: { items: [] } }, T), T), null);
  assertEquals(unpackReady(packReady({ ...review, mealType: "brunch" }, T), T), null);
  assertEquals(unpackReady(JSON.stringify({ v: 99, at: T, flow: review }), T), null);
});

Deno.test("a named serving steps by a half and never reaches zero", () => {
  assertEquals(stepAmount(1, false, 1), 1.5);
  assertEquals(stepAmount(1, false, -1), 0.5);
  assertEquals(stepAmount(0.5, false, -1), 0.5);
  assertEquals(stepAmount(2, false, 1), 2.5);
});

Deno.test("an odd amount snaps to the step grid", () => {
  assertEquals(stepAmount(1.3, false, 1), 1.5);
  assertEquals(stepAmount(1.3, false, -1), 1);
  assertEquals(stepAmount(143, true, 1), 150);
  assertEquals(stepAmount(143, true, -1), 140);
});

Deno.test("grams step in sizes that suit the amount", () => {
  assertEquals(stepAmount(30, true, 1), 35);
  assertEquals(stepAmount(150, true, 1), 160);
  assertEquals(stepAmount(600, true, -1), 550);
  assertEquals(stepAmount(5, true, -1), 5);
});

const line = {
  food_name: "Roti", quantity: 2, grams: 80, kcal: 240, protein_g: 8, carb_g: 44, fat_g: 3.6,
  fiber_g: 4, source: "catalog", assumption: "Same as you logged on Oct 14",
};

Deno.test("every number on a line moves with its amount, the rest stays", () => {
  const out = scaleLine(line, 3);
  assertEquals(out, {
    ...line, quantity: 3, grams: 120, kcal: 360, protein_g: 12, carb_g: 66, fat_g: 5.4, fiber_g: 6,
  });
});

Deno.test("no fiber stays no fiber, and a bad amount changes nothing", () => {
  assertEquals(scaleLine({ ...line, fiber_g: null }, 1).fiber_g, null);
  assertEquals(scaleLine(line, 0), line);
  assertEquals(scaleLine(line, 2), line);
});
