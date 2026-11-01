// Run with: deno test lib/mealReady.test.ts
//
// lib/mealReady.ts has no imports, so Deno can test it directly.

import { assertEquals } from "jsr:@std/assert@1";
import {
  type AmountLine,
  arrivalAction,
  MAYBE_ADDED_NOTICE,
  packAdding,
  packReady,
  READY_MAX_AGE_MS,
  readyAction,
  readyLine,
  readyStoreStep,
  settleRestoredKey,
  showPlan,
  addLabel,
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

Deno.test("a meal is counted as shown when it is seen, not when it lands", () => {
  assertEquals(showPlan("review", "show"), { via: "result", when: "now" });
  assertEquals(showPlan("error", "show"), { via: "box", when: "now" });
  assertEquals(showPlan("review", "tell"), { via: "toast", when: "now" });
  // In the background the toast, and the count, wait for the return.
  assertEquals(showPlan("review", "tell_later"), { via: "toast", when: "on_return" });
  assertEquals(showPlan("logged", "tell_later"), { via: "toast", when: "on_return" });
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
  meal: {
    items: [{
      food_name: "egg", quantity: 2, serving_label: "1 large", grams: 100, kcal: 143,
      protein_g: 12.6, carb_g: 0.7, fat_g: 9.5, fiber_g: null,
    }],
    meal_type: "breakfast",
    drona_line: "Solid start.",
  },
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

Deno.test("a stored meal with a line the screen cannot draw is dropped", () => {
  // The restore runs on mount: one bad line would crash every launch.
  const T = 1_000_000_000;
  const egg = review.meal.items[0];
  const bad = (item: Record<string, unknown>) =>
    unpackReady(packReady({ ...review, meal: { ...review.meal, items: [egg, item] } }, T), T);
  const { kcal: _k, ...noKcal } = egg;
  assertEquals(bad(noKcal), null);
  assertEquals(bad({ ...egg, protein_g: "12" }), null);
  assertEquals(bad({ ...egg, grams: null }), null);
  assertEquals(bad({ ...egg, fiber_g: "1" }), null);
  assertEquals(bad(null as unknown as Record<string, unknown>), null);
  assertEquals(bad({ ...egg, serving_label: undefined }), null);
  assertEquals(bad({ ...egg, fiber_g: 1.2 })?.meal.items.length, 2);
});

Deno.test("a meal killed mid-Add comes back flagged, never as a fresh Add", () => {
  const T = 1_000_000_000;
  const back = unpackReady<typeof review & { notice?: string | null }>(
    packAdding({ ...review, notice: "Solid start." }, T), T + 60_000,
  );
  assertEquals(back?.notice, MAYBE_ADDED_NOTICE);
  assertEquals("adding" in (back ?? {}), false);
  assertEquals(back?.meal, review.meal);
  // A plain waiting meal keeps its own note.
  assertEquals(unpackReady<typeof review & { notice?: string | null }>(packReady(review, T), T)?.notice, undefined);
  assertEquals(MAYBE_ADDED_NOTICE.includes("—"), false);
});

Deno.test("- never raises a small amount", () => {
  assertEquals(stepAmount(3, true, -1), 3);
  assertEquals(stepAmount(0.25, false, -1), 0.25);
  assertEquals(stepAmount(0.4, false, -1), 0.4);
  assertEquals(stepAmount(7, true, -1), 5);
  assertEquals(stepAmount(0.75, false, -1), 0.5);
  // + still moves them up to the grid.
  assertEquals(stepAmount(3, true, 1), 5);
  assertEquals(stepAmount(0.25, false, 1), 0.5);
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
  const { amount_base, ...out } = scaleLine(line as typeof line & AmountLine, 3);
  assertEquals(out, {
    ...line, quantity: 3, grams: 120, kcal: 360, protein_g: 12, carb_g: 66, fat_g: 5.4, fiber_g: 6,
  });
  assertEquals(amount_base?.kcal, 240);
});

Deno.test("no fiber stays no fiber, and a bad amount changes nothing", () => {
  assertEquals(scaleLine({ ...line, fiber_g: null }, 1).fiber_g, null);
  assertEquals(scaleLine(line, 0), line);
  assertEquals(scaleLine(line, 2), line);
});

// ── What happens to the stored meal ─────────────────────────────────────────

const ready = { key: "overload.mealReady.u1", restoredKey: "overload.mealReady.u1", adding: false };

Deno.test("a waiting meal is stored", () => {
  assertEquals(readyStoreStep(review, ready), { kind: "save", flow: review });
});

Deno.test("tapping Add does not clear the meal while the write is still out", () => {
  // Add sets the flow idle at once; the write lands later.
  assertEquals(readyStoreStep({ status: "idle" }, { ...ready, adding: true }), { kind: "keep" });
});

Deno.test("the meal is cleared only once the write has landed", () => {
  assertEquals(readyStoreStep({ status: "idle" }, ready), { kind: "clear" });
});

Deno.test("a failed Add stores the meal as waiting again, with the failure as its note", () => {
  const failed = {
    status: "error", raw: review.raw, meal: review.meal, mealType: review.mealType,
    dayIso: review.dayIso, message: "Could not add that. Try again.",
  };
  assertEquals(readyStoreStep(failed, ready), {
    kind: "save",
    flow: {
      status: "review", raw: review.raw, meal: review.meal, mealType: review.mealType,
      dayIso: review.dayIso, notice: "Could not add that. Try again.",
    },
  });
});

Deno.test("an error with no meal (a failed parse) leaves the store alone", () => {
  assertEquals(readyStoreStep({ status: "error", raw: "x", message: "no" }, ready), { kind: "keep" });
});

Deno.test("nothing is written before this account's meal is read back", () => {
  assertEquals(readyStoreStep(review, { ...ready, restoredKey: null }), { kind: "skip" });
  assertEquals(readyStoreStep({ status: "idle" }, { ...ready, restoredKey: null }), { kind: "skip" });
});

Deno.test("a new account never gets the last account's meal", () => {
  // Signed in as u2, while the restore still belongs to u1.
  assertEquals(
    readyStoreStep(review, { key: "overload.mealReady.u2", restoredKey: "overload.mealReady.u1", adding: false }),
    { kind: "skip" },
  );
  assertEquals(readyStoreStep(review, { key: null, restoredKey: null, adding: false }), { kind: "skip" });
});

Deno.test("a correction being read keeps the stored meal", () => {
  assertEquals(readyStoreStep({ status: "analysing", raw: "make it 2" }, ready), { kind: "keep" });
});

// ── Steps scale from the line as first seen ────────────────────────────────

const raw = {
  food_name: "Paneer tikka", quantity: 1, grams: 52.4, kcal: 142.7, protein_g: 3.25,
  carb_g: 18.33, fat_g: 6.05, fiber_g: 1.47, source: "estimate",
};
const numbers = (l: typeof raw) => ({
  quantity: l.quantity, grams: l.grams, kcal: l.kcal, protein_g: l.protein_g,
  carb_g: l.carb_g, fat_g: l.fat_g, fiber_g: l.fiber_g,
});

Deno.test("+, +, -, - comes back to the original numbers", () => {
  let l: typeof raw & AmountLine = raw;
  for (const d of [1, 1, -1, -1] as const) l = scaleLine(l, stepAmount(l.quantity, false, d));
  assertEquals(numbers(l), numbers(raw));
});

Deno.test("a line changed by hand starts its steps from the new numbers", () => {
  const up = scaleLine(raw, 1.5);
  // The editor sets 300 kcal by hand; the old base no longer describes it.
  const edited = { ...up, kcal: 300 };
  assertEquals(scaleLine(edited, 3).kcal, 600);
});

// ── The Add button names a day that is not today ───────────────────────────

Deno.test("a meal for today just says where it goes", () => {
  assertEquals(addLabel("Lunch", "Today"), "Add to Lunch");
});

Deno.test("a meal restored the next morning says it is for yesterday", () => {
  assertEquals(addLabel("Lunch", "Yesterday"), "Add to Lunch · Yesterday");
  assertEquals(addLabel("2 meals", "Thu, Oct 30"), "Add to 2 meals · Thu, Oct 30");
});

// ── Signing out and back in ────────────────────────────────────────────────

Deno.test("signing out and back in as the same account never clears the stored meal", () => {
  const k = "overload.mealReady.u1";
  let restored: string | null = k;
  // Sign out: the key goes, and with it the "already read" mark.
  restored = settleRestoredKey(restored, null);
  // Sign back in as u1. The flow is idle and the read is still out.
  restored = settleRestoredKey(restored, k);
  assertEquals(readyStoreStep({ status: "idle" }, { key: k, restoredKey: restored, adding: false }), { kind: "skip" });
});

Deno.test("an unchanged key keeps its restore", () => {
  assertEquals(settleRestoredKey("k", "k"), "k");
  assertEquals(settleRestoredKey("k", "k2"), null);
});
