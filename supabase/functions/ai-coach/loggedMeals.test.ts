import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  listLoggedMeals,
  type LoggedMealsResult,
  type MealRowIn,
  resolveDay,
  shapeLoggedMeals,
  todayFor,
  zoneOffsetMin,
} from "./loggedMeals.ts";

// 2026-09-22 02:00 UTC = 07:30 in India, still 2026-09-21 in New York.
const NOW = Date.UTC(2026, 8, 22, 2, 0, 0);

Deno.test("zone offset uses getTimezoneOffset sign: India is -330", () => {
  assertEquals(zoneOffsetMin("Asia/Kolkata", NOW), -330);
  assertEquals(zoneOffsetMin("UTC", NOW), 0);
  assertEquals(zoneOffsetMin("America/New_York", NOW), 240);
});

Deno.test("today is the user's today, not the server's", () => {
  // At 02:00 UTC the server and New York both say the 21st, India says the 22nd.
  assertEquals(todayFor({ timeZone: "Asia/Kolkata", nowMs: NOW }), "2026-09-22");
  assertEquals(todayFor({ timeZone: "America/New_York", nowMs: NOW }), "2026-09-21");
  // The phone's own date beats everything.
  assertEquals(todayFor({ timeZone: "Asia/Kolkata", todayLocal: "2026-09-20", nowMs: NOW }), "2026-09-20");
  // Offset only.
  assertEquals(todayFor({ tzOffsetMin: -330, nowMs: NOW }), "2026-09-22");
});

Deno.test("yesterday in India is the Indian day, as a UTC window", () => {
  const d = resolveDay({ days_ago: 1 }, { timeZone: "Asia/Kolkata", nowMs: NOW });
  assert(!("error" in d));
  assertEquals(d.date, "2026-09-21");
  assertEquals(d.weekday, "Monday");
  // Local midnight IST = 18:30 UTC the day before.
  assertEquals(d.startIso, "2026-09-20T18:30:00.000Z");
  assertEquals(d.endIso, "2026-09-21T18:29:59.999Z");
  assertEquals(d.guessedZone, false);
});

Deno.test("an explicit date wins over days_ago", () => {
  const d = resolveDay({ date: "2026-09-19", days_ago: 1 }, { timeZone: "Asia/Kolkata", nowMs: NOW });
  assert(!("error" in d));
  assertEquals(d.date, "2026-09-19");
});

Deno.test("future days, bad dates, and far-back days are errors, not empty results", () => {
  const clock = { timeZone: "Asia/Kolkata", nowMs: NOW };
  assert("error" in resolveDay({ date: "2026-09-23" }, clock));
  assert("error" in resolveDay({ date: "2026-02-30" }, clock));
  assert("error" in resolveDay({ date: "yesterday" }, clock));
  assert("error" in resolveDay({ days_ago: -1 }, clock));
  assert("error" in resolveDay({ days_ago: 91 }, clock));
  assert(!("error" in resolveDay({ days_ago: 90 }, clock)));
});

Deno.test("no zone at all falls back to UTC and says so", () => {
  const d = resolveDay({ days_ago: 0 }, { nowMs: NOW });
  assert(!("error" in d));
  assertEquals(d.guessedZone, true);
  const out = shapeLoggedMeals([], d, null);
  assert(out.time_zone.includes("unknown"));
});

const DAY = (() => {
  const d = resolveDay({ days_ago: 1 }, { timeZone: "Asia/Kolkata", nowMs: NOW });
  if ("error" in d) throw new Error(d.error);
  return d;
})();

const ROWS: MealRowIn[] = [
  {
    meal_type: "lunch",
    logged_at: "2026-09-21T07:45:00Z", // 13:15 IST
    meal_entries: [{ food_name: "Dal", quantity: 1, serving_unit: "katori", kcal: 180, protein_g: 9, carb_g: 25, fat_g: 4, position: 0 }],
  },
  {
    meal_type: "breakfast",
    logged_at: "2026-09-21T02:40:00Z", // 08:10 IST
    meal_entries: [
      { food_name: "Banana", quantity: 1, serving_unit: "medium", kcal: 105, protein_g: 1.3, carb_g: 27, fat_g: 0.4, position: 1 },
      { food_name: "Rolled oats", quantity: 60, serving_unit: "g", grams_logged: 60, kcal: 228, protein_g: 8, carb_g: 40, fat_g: 4, position: 0 },
    ],
  },
  // A section whose entries were all deleted, EARLIER than the real meals, so
  // mishandling it cannot hide behind being last.
  { meal_type: "snack", logged_at: "2026-09-21T01:00:00Z", meal_entries: [] },
];

Deno.test("meals come back in time order, local times, items in position order", () => {
  const out = shapeLoggedMeals(ROWS, DAY, null);
  assertEquals(out.meals.map((m) => m.meal_type), ["breakfast", "lunch"]);
  assertEquals(out.meals[0].time, "08:10");
  assertEquals(out.meals[1].time, "13:15");
  assertEquals(out.meals[0].items.map((i) => i.name), ["Rolled oats", "Banana"]);
  assertEquals(out.meals[0].items[0].grams, 60);
  assertEquals(out.meals[0].items[1].grams, undefined);
  assertEquals(out.meals[0].totals.kcal, 333);
  assertEquals(out.day_totals?.kcal, 513);
  assertEquals(out.time_zone, "Asia/Kolkata");
});

Deno.test("a meal_type filter returns only that section", () => {
  const out = shapeLoggedMeals(ROWS, DAY, "breakfast");
  assertEquals(out.meals.length, 1);
  assertEquals(out.meal_type_filter, "breakfast");
  assertEquals(out.day_totals?.kcal, 333);
});

Deno.test("an empty section names the ones that DO have food, so the coach can ask", () => {
  const out = shapeLoggedMeals(ROWS, DAY, "dinner");
  assertEquals(out.meals, []);
  assertEquals(out.other_meals_that_day, ["breakfast", "lunch"]);
  assert(out.note?.includes("ask"));
});

Deno.test("an empty day says nothing was logged", () => {
  const out = shapeLoggedMeals([], DAY, null);
  assertEquals(out.meals, []);
  assertEquals(out.other_meals_that_day, undefined);
  assert(out.note?.startsWith("Nothing logged on 2026-09-21"));
});

Deno.test("listLoggedMeals queries the resolved window and rejects a bad meal_type", async () => {
  let asked: [string, string] | null = null;
  const store = {
    mealsBetween: (s: string, e: string) => {
      asked = [s, e];
      return Promise.resolve({ rows: ROWS });
    },
  };
  const out = await listLoggedMeals({ days_ago: 1, meal_type: "Breakfast" }, { timeZone: "Asia/Kolkata", nowMs: NOW }, store);
  assertEquals(asked, ["2026-09-20T18:30:00.000Z", "2026-09-21T18:29:59.999Z"]);
  assertEquals((out as LoggedMealsResult).meals.length, 1);

  const bad = await listLoggedMeals({ meal_type: "brunch" }, { timeZone: "Asia/Kolkata", nowMs: NOW }, store);
  assert("error" in bad);
});

Deno.test("a store error is passed through, never turned into 'nothing logged'", async () => {
  const store = { mealsBetween: () => Promise.resolve({ error: "boom" }) };
  const out = await listLoggedMeals({}, { timeZone: "Asia/Kolkata", nowMs: NOW }, store);
  assertEquals(out, { error: "boom" });
});
