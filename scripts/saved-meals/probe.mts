// Does the parse model recognise a saved meal, and refuse when it should?
//   npx tsx scripts/saved-meals/probe.mts           (routes through `claude -p`)
// Correctness only: the CLI route makes timings meaningless.
import { runParseMeal, type ParseMealDeps } from "../../supabase/functions/ai-coach/parseMeal.ts";
import type { SavedMealForParse } from "../../supabase/functions/ai-coach/savedMeals.ts";
import { makeClaudeCliFetch } from "../parse-meal-eval/claude-cli-fetch.ts";

const item = (food_name: string, kcal: number) => ({
  food_id: null, food_name, quantity: 1, serving_unit: "serving", grams: null,
  kcal, protein_g: 5, carb_g: 10, fat_g: 3, fiber_g: null,
});
const meal = (id: string, name: string, items: [string, number][]): SavedMealForParse => ({
  id, name, kind: "meal", servings: 1, serving_label: null,
  kcal: items.reduce((s, [, k]) => s + k, 0), protein_g: 20, carb_g: 40, fat_g: 10,
  items: items.map(([n, k]) => item(n, k)),
});
const SAVED: SavedMealForParse[] = [
  meal("oats", "Oats with milk", [["oats", 180], ["milk", 370]]),
  meal("shake", "Post workout shake", [["whey", 120], ["banana", 105]]),
  meal("bowl", "Breakfast bowl", [["greek yogurt", 150], ["granola", 200], ["berries", 50]]),
  meal("rajma", "Amma's rajma", [["rajma", 400]]),
  meal("salad", "Office salad", [["lettuce", 20], ["chicken", 250], ["dressing", 90]]),
];

const CASES: { text: string; want: string[] }[] = [
  { text: "Can you log the oat meal to breakfast", want: ["oats"] },
  { text: "my usual oats with milk", want: ["oats"] },
  { text: "had my shake after the gym", want: ["shake"] },
  { text: "breakfast bowl and a coffee", want: ["bowl"] },
  { text: "2 servings of amma's rajma", want: ["rajma"] },
  { text: "office salad for lunch and an apple", want: ["salad"] },
  // Must NOT match. A food that is only PART of a saved meal is searched (1A).
  { text: "log my oats", want: [] },
  { text: "oats in breakfast", want: [] },
  { text: "a banana after the gym", want: [] },
  { text: "40g oats with water", want: [] },
  { text: "a protein shake from the cafe", want: [] },
  { text: "rajma chawal at a restaurant", want: [] },
  { text: "caesar salad", want: [] },
  { text: "two eggs and toast", want: [] },
  { text: "a smoothie bowl", want: [] },
];

const deps: ParseMealDeps = {
  anthropicApiKey: "cli", model: "claude-haiku-4-5", maxTokens: 1500, timeoutMs: 180_000,
  webSearchEnabled: false,
  fetchFn: makeClaudeCliFetch("claude-haiku-4-5"),
  searchFoods: async () => [], searchFatSecret: async () => [],
  backfillOffFood: async () => null, preciseCacheGet: async () => null,
  getFoodPer100: async () => null, getFoodServings: async () => [],
};

let bad = 0;
async function one(c: { text: string; want: string[] }) {
  try {
    const r = await runParseMeal(deps, {
      text: c.text, localHour: 9, mealHint: null, mode: "fast",
      recentFoods: [], todayTotals: null, targets: null, savedMeals: SAVED,
    });
    const step = r.steps.find((s) => s.tool === "saved_meal");
    const got = ((step?.result as { id: string }[] | undefined) ?? []).map((h) => h.id);
    const ok = JSON.stringify(got.sort()) === JSON.stringify([...c.want].sort());
    return { c, got, ok, items: (r.parsed?.items ?? []).map((i) => `${i.food_name}:${i.kcal}`).join(", ") };
  } catch (e) {
    return { c, got: ["ERR " + String(e).slice(0, 80)], ok: false, items: "" };
  }
}
// 4 at a time: more than that and `claude -p` starts returning empty envelopes.
const results: Awaited<ReturnType<typeof one>>[] = [];
if (process.env.ONLY_REJECTS) CASES.length = 0;
for (let i = 0; i < CASES.length; i += 4) results.push(...await Promise.all(CASES.slice(i, i + 4).map(one)));
for (const { c, got, ok, items } of results) {
  if (!ok) bad++;
  console.log(`${ok ? "  " : "XX"} want=[${c.want}] got=[${got}]  ${c.text}  ->  ${items}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} correct`);

// ── Scenario 2: a correction turn that rejects the saved meal ───────────────
const PREV = {
  previousText: "Can you log the oat meal to breakfast",
  previousItems: [
    { food_id: null, food_name: "oats", quantity: 48, serving_label: "g", grams: 48, kcal: 180, protein_g: 6, carb_g: 32, fat_g: 3, fiber_g: 5, source: "manual" as const },
    { food_id: null, food_name: "milk", quantity: 550, serving_label: "ml", grams: 550, kcal: 370, protein_g: 19, carb_g: 28, fat_g: 17, fiber_g: null, source: "manual" as const },
  ],
  recentTurns: [
    { role: "user" as const, text: "Can you log the oat meal to breakfast" },
    { role: "drona" as const, text: "Your saved Oats with milk, with your own numbers. 550 kcal." },
  ],
};
const REJECTS: { text: string; want: boolean }[] = [
  { text: "not from saved meals", want: true },
  { text: "don't use my saved one, estimate it", want: true },
  { text: "make the milk 300 ml", want: false },
  { text: "add a banana", want: false },
];
let rbad = 0;
for (const c of REJECTS) {
  try {
    const r = await runParseMeal(deps, {
      text: c.text, localHour: 9, mealHint: null, mode: "fast",
      recentFoods: [], todayTotals: null, targets: null, savedMeals: SAVED, ...PREV,
    });
    const got = r.steps.some((s) => s.tool === "rejects_saved");
    if (got !== c.want) rbad++;
    if (!r.parsed) console.log(`   declined: ${JSON.stringify(r.declined)} steps: ${r.steps.map((s) => s.tool).join(",")}`);
    console.log(`${got === c.want ? "  " : "XX"} rejects want=${c.want} got=${got}  ${c.text}  ->  ${(r.parsed?.items ?? []).map((i) => `${i.food_name}:${i.kcal}`).join(", ")}`);
  } catch (e) {
    rbad++;
    console.log(`XX ${c.text}  ERR ${String(e).slice(0, 80)}`);
  }
}
console.log(`\n${REJECTS.length - rbad}/${REJECTS.length} rejection cases correct`);
