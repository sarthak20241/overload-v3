// Run with: deno test --allow-all lib/foodPatterns.test.ts
//
// lib/foodPatterns.ts has no imports, so Deno tests it directly. "Today" is
// Sunday 18 Oct 2026 in every case.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  copyableFromDay, learnPatterns, mealsToSuggest, relogColumns, relogLabels,
  type FoodSuggestion, type HistoryEntry, type PatternMeal,
} from "./foodPatterns.ts";

const TODAY = "2026-10-18"; // a Sunday
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => ymd(new Date(2026, 9, 18 - n));

const entry = (dayIso: string, meal: PatternMeal, name: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  dayIso, meal_type: meal, food_id: null, food_name: name, quantity: 1, serving_unit: "serving",
  grams_logged: null, kcal: 100, protein_g: 5, carb_g: 10, fat_g: 3, fiber_g: null, source: "catalog", ...over,
});
const names = (list: FoodSuggestion[]) => list.map((s) => s.food_name);
const none = () => ({ breakfast: [], lunch: [], dinner: [], snack: [] });

Deno.test("a food in breakfast most days is a daily usual", () => {
  const h: HistoryEntry[] = [];
  for (let i = 1; i <= 10; i++) h.push(entry(daysAgo(i), "breakfast", "Oats"));
  h.push(entry(daysAgo(3), "breakfast", "Banana"));
  const p = learnPatterns(h, TODAY);
  assertEquals(names(p.breakfast), ["Oats"]); // banana: one day is a one-off
  assertEquals(p.breakfast[0].reason, "daily");
  assert(p.breakfast[0].usual);
  assertEquals(p.lunch, []);
});

Deno.test("rates are over days the meal was logged, not calendar days", () => {
  // Breakfast logged only 4 of the last 28 days, eggs every time.
  const h = [3, 9, 15, 21].map((n) => entry(daysAgo(n), "breakfast", "Eggs"));
  const p = learnPatterns(h, TODAY);
  assertEquals(names(p.breakfast), ["Eggs"]);
  assert(p.breakfast[0].usual);
});

Deno.test("a Sunday-only dinner shows on Sunday and not on Monday", () => {
  const h: HistoryEntry[] = [];
  for (let i = 1; i <= 28; i++) h.push(entry(daysAgo(i), "dinner", i % 7 === 0 ? "Pizza" : "Dal rice"));
  const sunday = learnPatterns(h, TODAY);
  const pizza = sunday.dinner.find((s) => s.food_name === "Pizza");
  assert(pizza, "pizza should be offered on a Sunday");
  assertEquals(pizza.reason, "weekday");
  const monday = learnPatterns(h, "2026-10-19");
  assertEquals(monday.dinner.some((s) => s.food_name === "Pizza"), false);
});

Deno.test("only history before the day counts: today and planned days never teach", () => {
  const h = [
    entry(TODAY, "lunch", "Salad"),
    entry(daysAgo(-1), "lunch", "Salad"),
    entry(daysAgo(-2), "lunch", "Salad"),
    entry(daysAgo(1), "lunch", "Salad"),
  ];
  assertEquals(learnPatterns(h, TODAY).lunch, []);
});

Deno.test("food planned ahead never teaches, even viewing a later day", () => {
  // Today is Sun 18. Lunch is planned for Mon 19 and Tue 20; the user looks at Wed 21.
  const h = [
    entry("2026-10-19", "lunch", "Meal prep bowl"),
    entry("2026-10-20", "lunch", "Meal prep bowl"),
  ];
  assertEquals(learnPatterns(h, "2026-10-21", TODAY).lunch, []);
  // Without the real today, the planned days look like eaten ones.
  assertEquals(learnPatterns(h, "2026-10-21").lunch.length, 1);
});

Deno.test("history older than the window is forgotten", () => {
  const h = [40, 45, 50].map((n) => entry(daysAgo(n), "snack", "Protein bar"));
  assertEquals(learnPatterns(h, TODAY).snack, []);
});

Deno.test("the portion offered is the one logged most, with that entry's numbers", () => {
  const h = [
    entry(daysAgo(1), "breakfast", "Whole milk", { quantity: 1, serving_unit: "cup", kcal: 150 }),
    entry(daysAgo(2), "breakfast", "Whole milk", { quantity: 2, serving_unit: "cup", kcal: 300 }),
    entry(daysAgo(3), "breakfast", "Whole milk", { quantity: 2, serving_unit: "cup", kcal: 300 }),
  ];
  const s = learnPatterns(h, TODAY).breakfast[0];
  assertEquals([s.quantity, s.serving_unit, s.kcal], [2, "cup", 300]);
});

Deno.test("a suggestion keeps how its line was logged, so an estimate stays one", () => {
  const h = [
    entry(daysAgo(1), "lunch", "Dal", { logged_via: "ai", tier: "fast", source: "estimate" }),
    entry(daysAgo(2), "lunch", "Dal", { logged_via: "ai", tier: "fast", source: "estimate" }),
  ];
  const s = learnPatterns(h, TODAY).lunch[0];
  assertEquals([s.logged_via, s.tier, s.source], ["ai", "fast", "estimate"]);
});

Deno.test("names match regardless of case and spacing", () => {
  const h = [
    entry(daysAgo(1), "breakfast", "Black coffee"),
    entry(daysAgo(2), "breakfast", "black  coffee "),
  ];
  assertEquals(learnPatterns(h, TODAY).breakfast.length, 1);
});

Deno.test("a dropped habit ranks below a current one", () => {
  const h: HistoryEntry[] = [];
  for (let i = 15; i <= 28; i++) h.push(entry(daysAgo(i), "breakfast", "Cornflakes"));
  for (let i = 1; i <= 14; i++) h.push(entry(daysAgo(i), "breakfast", "Poha"));
  assertEquals(names(learnPatterns(h, TODAY).breakfast)[0], "Poha");
});

// ── When to show ─────────────────────────────────────────────────────────────

const sug = (meal: PatternMeal, name: string, usual = true): FoodSuggestion => ({
  key: `${meal}:${name}`, meal_type: meal, food_id: null, food_name: name, quantity: 1, serving_unit: "serving",
  grams_logged: null, kcal: 100, protein_g: 5, carb_g: 10, fat_g: 3, fiber_g: null, source: null,
  logged_via: null, tier: null,
  score: usual ? 0.8 : 0.35, reason: "daily", usual,
});
const patterns = () => ({
  breakfast: [sug("breakfast", "Oats"), sug("breakfast", "Coffee"), sug("breakfast", "Banana", false)],
  lunch: [sug("lunch", "Dal rice")],
  dinner: [sug("dinner", "Roti sabzi")],
  snack: [sug("snack", "Whey")],
});
const open = (r: Record<PatternMeal, FoodSuggestion[]>) =>
  (Object.keys(r) as PatternMeal[]).filter((m) => r[m].length > 0);

Deno.test("morning offers breakfast only", () => {
  assertEquals(open(mealsToSuggest(patterns(), none(), 8)), ["breakfast"]);
});

Deno.test("at lunch an unlogged breakfast is still offered beside lunch", () => {
  assertEquals(open(mealsToSuggest(patterns(), none(), 13)), ["breakfast", "lunch", "snack"]);
});

Deno.test("by dinner a skipped breakfast is no longer offered", () => {
  assertEquals(open(mealsToSuggest(patterns(), none(), 19)), ["lunch", "dinner", "snack"]);
});

Deno.test("after midnight is still the night: no breakfast at 2am", () => {
  assertEquals(open(mealsToSuggest(patterns(), none(), 2)), ["dinner", "snack"]);
});

Deno.test("a logged meal keeps only its missing usuals", () => {
  const logged = { ...none(), breakfast: [{ food_name: "oats" }] };
  const r = mealsToSuggest(patterns(), logged, 8);
  assertEquals(names(r.breakfast), ["Coffee"]); // banana is not a usual; oats is in
});

Deno.test("another day has no clock: every meal is open", () => {
  assertEquals(open(mealsToSuggest(patterns(), none(), null)), ["breakfast", "lunch", "dinner", "snack"]);
});

Deno.test("copy skips what is already in today's meal", () => {
  const prev = [{ food_name: "Eggs" }, { food_name: "Toast" }, { food_name: "Coffee" }];
  assertEquals(copyableFromDay(prev, [{ food_name: "toast" }]), [0, 2]);
  assertEquals(copyableFromDay(prev, []), [0, 1, 2]);
});

// ── Re-log labels ────────────────────────────────────────────────────────────

Deno.test("a copied line keeps its label: an AI estimate is never promoted to manual", () => {
  assertEquals(relogLabels({ logged_via: "ai", tier: "fast" }), { logged_via: "ai", tier: "fast" });
  assertEquals(relogLabels({ logged_via: "ai_auto", tier: "thorough" }), { logged_via: "ai", tier: "thorough" });
  assertEquals(relogLabels({ logged_via: "manual", tier: null }), { logged_via: "manual", tier: null });
  assertEquals(relogLabels({ logged_via: null }), { logged_via: null, tier: null });
  assertEquals(relogLabels({ logged_via: "something new" }), { logged_via: null, tier: null });
});

Deno.test("columns written: fresh parse, unedited copy, edited copy", () => {
  const copy = relogLabels({ logged_via: "ai", tier: "fast" });
  assertEquals(relogColumns("estimate", undefined), { logged_via: "ai", tier: null });
  assertEquals(relogColumns("estimate", copy), { logged_via: "ai", tier: "fast" });
  // Changed in the review card: the numbers are the user's now.
  assertEquals(relogColumns("manual", copy), { logged_via: "manual", tier: null });
});
