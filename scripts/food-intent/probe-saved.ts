// Does the saved-meal match separate? Run against the live API.
//   deno run --allow-net --allow-env scripts/food-intent/probe-saved.ts
//
// This one matters more than the intent probe. A wrong intent shows a card the
// user dismisses; a wrong MATCH logs the wrong numbers under a name they
// recognise, which looks right. So the question here is not "how often is it
// correct" but "does it refuse when it should".
import { routeFoodIntent, type SavedMealSummary, SAVED_MATCH_FLOOR } from "../../supabase/functions/ai-coach/foodIntent.ts";

// A plausible My Meals list, with traps: two bowls, a short form, and a name
// that is a substring of ordinary food words.
const SAVED: SavedMealSummary[] = [
  { id: "m1", name: "Breakfast bowl", kcal: 520, item_count: 3 },
  { id: "m2", name: "Post workout shake", kcal: 280, item_count: 2 },
  { id: "m3", name: "Amma's rajma", kcal: 400, item_count: 1 },
  { id: "m4", name: "Office salad", kcal: 320, item_count: 4 },
  { id: "m5", name: "Dosa", kcal: 600, item_count: 1 },
];

const CASES: { text: string; want: string | null }[] = [
  // Should match.
  { text: "had my breakfast bowl", want: "m1" },
  { text: "post workout shake", want: "m2" },
  { text: "ate amma's rajma tonight", want: "m3" },
  { text: "office salad for lunch", want: "m4" },
  { text: "one dosa", want: "m5" },
  { text: "my shake after the gym", want: "m2" },
  { text: "rajma, the one my mum makes", want: "m3" },

  // Must NOT match. These are the ones that matter.
  { text: "two eggs and toast", want: null },
  { text: "a bowl of dal and rice", want: null },          // "bowl" but not THE bowl
  { text: "protein shake from the cafe", want: null },      // a shake, not THEIR shake
  { text: "rajma chawal at a restaurant", want: null },     // rajma, not Amma's
  { text: "caesar salad", want: null },                     // salad, not the office one
  { text: "idli sambar", want: null },
  { text: "chicken and rice", want: null },
  { text: "a smoothie bowl", want: null },                  // "bowl" again
  { text: "large coffee", want: null },
];

const apiKey = Deno.env.get("JEV_API_KEY") ?? "";
if (!apiKey) { console.error("JEV_API_KEY is not set."); Deno.exit(1); }

let hit = 0, falsePos = 0, missed = 0;
const rows: string[] = [];

for (const c of CASES) {
  const d = await routeFoodIntent(c.text, {
    jev: { apiKey, timeoutMs: 15_000 },
    savedMeals: SAVED,
  });
  const got = d.savedMatch?.id ?? null;
  const ok = got === c.want;
  if (ok && c.want) hit++;
  if (!ok && c.want === null) falsePos++;   // matched something it should not have
  if (!ok && c.want !== null) missed++;     // failed to match something it should have
  const conf = d.savedMatch ? `${(d.savedMatch.confidence * 100).toFixed(0)}%` : "-";
  rows.push(
    `${ok ? "  " : "XX"} want=${(c.want ?? "none").padEnd(5)} got=${(got ?? "none").padEnd(5)} ` +
      `conf=${conf.padStart(4)} ${d.savedMatch?.name ?? ""}`.padEnd(40) + ` ${c.text}`,
  );
}

console.log(`floor ${SAVED_MATCH_FLOOR}\n`);
for (const r of rows) console.log(r);
console.log(`\nmatched correctly     ${hit}`);
console.log(`FALSE POSITIVES       ${falsePos}   <- the dangerous ones`);
console.log(`missed a real match   ${missed}   <- costs nothing, falls through to the catalog`);
