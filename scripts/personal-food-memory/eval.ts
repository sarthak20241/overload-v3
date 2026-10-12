// Live Jev evaluation of the PRODUCTION matcher, no Anthropic calls.
// deno run --allow-read --allow-env --allow-net scripts/personal-food-memory/eval.ts
// Set FOOD_MEMORY_ENV_FILE when .env.local is outside the checkout.
import { matchMemory, type MemoryFood } from "../../supabase/functions/ai-coach/userFoodMemory.ts";

const env: Record<string, string> = {};
try {
  for (const line of Deno.readTextFileSync(Deno.env.get("FOOD_MEMORY_ENV_FILE") ?? ".env.local").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* env key alone is sufficient */ }
const jev = { apiKey: Deno.env.get("JEV_API_KEY") ?? env.JEV_API_KEY ?? "", timeoutMs: 20000 };
if (!jev.apiKey) throw new Error("JEV_API_KEY is required");

const cases: Array<[string, string[], number | null]> = [
  ["doctors banana caramel oats", ["Doctor's Choice banana caramel protein oats"], 0],
  ["doctors choice banana caramel oats", ["Doctor's Choice banana caramel protein oats"], 0],
  ["doctors banana caramel protein oats", ["Doctor's Choice banana caramel protein oats"], 0],
  ["doctors banana caramel oats", ["Doctor's Choice banana caramel protein oats", "Muscleblaze Apple Cinnamon Protein Oats", "walnuts", "whole eggs", "sauces and fats", "almonds", "Skimmed Milk", "raisins"], 0],
  ["doctors chocolate oats", ["Doctor's Choice banana caramel protein oats"], null],
  ["Quaker banana caramel oats", ["Doctor's Choice banana caramel protein oats"], null],
  ["doctors banana caramel oats", ["Doctor's Choice banana caramel protein oats", "Doctor's Choice banana caramel regular oats"], null],
  ["doctors banana caramel oats", ["Doctor's Choice banana caramel protein oats", "Doctor's Choice chocolate protein oats"], 0],
  ["doctors oats", ["Doctor's Choice banana caramel protein oats", "Doctor's Choice chocolate protein oats"], null],
  ["myprotein unflavoured casein", ["MyProtein Impact Casein Protein, Unflavoured"], 0],
  ["raw chicken breast", ["grilled chicken breast"], null],
  ["Amul full fat milk", ["Amul skimmed milk"], null],
  ["Amul milk", ["Amul skimmed milk", "Amul full fat milk"], null],
  ["chia seeds", ["sabja seeds"], null],
  ["blueberries", ["Blueberries, raw"], 0],
  ["banana caramel oats", ["Doctor's Choice banana caramel protein oats", "Quaker banana caramel oats"], null],
  // Additional products held out from the initial policy diagnosis.
  ["pintola crunchy peanut butter", ["Pintola All Natural Crunchy Peanut Butter"], 0],
  ["pintola smooth peanut butter", ["Pintola All Natural Crunchy Peanut Butter"], null],
  ["kelloggs corn flakes", ["Kellogg's Original Corn Flakes"], 0],
  ["kelloggs corn flakes", ["Kellogg's Original Corn Flakes", "Kellogg's Honey Corn Flakes"], null],
  ["optimum nutrition chocolate whey", ["Optimum Nutrition Gold Standard Whey Double Rich Chocolate"], 0],
  ["optimum nutrition vanilla whey", ["Optimum Nutrition Gold Standard Whey Double Rich Chocolate"], null],
  ["boiled white rice", ["White rice, cooked by boiling"], 0],
  ["fried white rice", ["White rice, cooked by boiling"], null],
];
const food = (name: string, i: number): MemoryFood => ({
  key: String(i), name, food_id: null,
  per100: { kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1, fiber_g: null },
  serving: null, source: "catalog", level: "precise", times: 1,
  last_logged_at: new Date().toISOString(),
});
let passed = 0, falseMatches = 0;
for (let i = 0; i < cases.length; i += 4) {
  await Promise.all(cases.slice(i, i + 4).map(async ([name, names, expected]) => {
    const result = await matchMemory(jev, names.map(food), { name, brand: null });
    const actual = result.food ? names.indexOf(result.food.name) : null;
    if (actual === expected) passed++;
    else if (actual !== null) falseMatches++;
    console.log(JSON.stringify({ input: name, expected: expected === null ? null : names[expected],
      actual: result.food?.name ?? null, confidence: result.confidence, pass: actual === expected,
      decision: result.trace.decision, rows: result.trace.rows }));
  }));
}
console.log(JSON.stringify({ passed, cases: cases.length, false_matches: falseMatches, model: "jev-1.13.0", floor: 0.75 }));
if (passed !== cases.length) Deno.exit(1);
