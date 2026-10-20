// Run with: deno test --allow-all supabase/functions/ai-coach/rejectedFood.test.ts
//
// A food the user swapped out of a line stays out. Live, 2026-10-19:
//   "still suji halwa is duplicated and why are u taking boiled chana, when I said navaratri chana"
// The extract tagged "Navratri chana" as replacing "boiled chana", then food
// memory matched "boiled chana" (Oct 16) and the card showed boiled chana again.
// Nothing here calls a real model, Jev or the database.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { foodNameKey, type ParseMealDeps, type PreviousItem, rejectedFood, runParseMeal, withoutRejected } from "./parseMeal.ts";

const prev = (food_name: string, quantity: number, serving_label: string, grams: number, kcal: number, food_id: string | null = null): PreviousItem =>
  ({ food_id, food_name, quantity, serving_label, grams, kcal, protein_g: 5, carb_g: 20, fat_g: 3, source: "catalog" }) as PreviousItem;
const CARD = [prev("poori", 3, "piece", 108, 321), prev("boiled chana", 75, "g", 75, 123), prev("Suji halwa", 40, "g", 40, 136)];

Deno.test("a swap rejects the old food; an edit of the same food does not", () => {
  assertEquals(rejectedFood({ name: "Navratri chana", correctsFoodName: "boiled chana" }, CARD), "boiled chana");
  assertEquals(rejectedFood({ name: "muesli", correctsFoodName: "corn flakes" }, []), "corn flakes");
  // Same food, more words: an edit.
  assertEquals(rejectedFood({ name: "3 egg omelette", correctsFoodName: "omelette" }, []), null);
  assertEquals(rejectedFood({ name: "chana", correctsFoodName: "boiled chana" }, CARD), null);
  // Vowel signs are part of a word: dropped, "चना" became "चन" and "पानी" broke
  // into "प न", so different names compared as the same fragments.
  assertEquals(foodNameKey("चना"), "चना");
  assertEquals(foodNameKey("उबले चने!"), "उबले चने");
  assert(foodNameKey("चना") !== foodNameKey("चने"));
  // Any script: a Hindi name is compared too.
  assertEquals(rejectedFood({ name: "नवरात्रि चना", correctsFoodName: "उबले चने" }, []), "उबले चने");
  // A grade, variant or new preparation changes the product even when one name
  // holds the other: these are swaps.
  assertEquals(rejectedFood({ name: "double toned milk", correctsFoodName: "toned milk" }, []), "toned milk");
  assertEquals(rejectedFood({ name: "fried egg", correctsFoodName: "egg" }, []), "egg");
  // Two foods sharing only one word: a swap.
  assertEquals(rejectedFood({ name: "chana masala", correctsFoodName: "boiled chana" }, []), "boiled chana");
  // A dish word added to an ingredient is a new food; an amount or size is not.
  assertEquals(rejectedFood({ name: "paneer butter masala", correctsFoodName: "paneer" }, []), "paneer");
  assertEquals(rejectedFood({ name: "paneer tikka", correctsFoodName: "paneer" }, []), "paneer");
  assertEquals(rejectedFood({ name: "large dosa", correctsFoodName: "dosa" }, []), null);
  // "whole" names a product, not a size.
  assertEquals(rejectedFood({ name: "whole milk", correctsFoodName: "milk" }, []), "milk");
  // A preparation extract split out of the name still counts.
  assertEquals(rejectedFood({ name: "egg", prep: "fried", correctsFoodName: "egg" }, []), "egg");
  // Untouched line.
  assertEquals(rejectedFood({ name: "poori", correctsFoodName: null }, CARD), null);
});

function deps(log: { decide: string[] }): ParseMealDeps {
  const boiled = {
    food_name: "boiled chana", food_id: null, kcal: 123, protein_g: 6.8, carb_g: 20.6, fat_g: 2, fiber_g: null,
    grams: 75, quantity: 75, serving_unit: "g", source: "catalog", logged_via: "ai", tier: "precise", logged_at: "2026-10-16T08:00:00Z",
  };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    if (String(url).includes("typesafe.ai")) {
      // Jev says every remembered food is the same food: the worst case.
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "score", probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 } }]));
      return Response.json({ model: "jev-test", usage: {}, answers });
    }
    const tool = body.tool_choice?.name;
    if (tool === "extract_meal") {
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input: {
        declined: false, corrects_previous: true, meal_type_from_text: null, items: [
          { name: "poori", brand: null, quantity: 3, unit: "piece", prep: null, corrects_food_name: null },
          { name: "Navratri chana", brand: null, quantity: 75, unit: "g", prep: null, corrects_food_name: "boiled chana" },
          { name: "Suji halwa", brand: null, quantity: 40, unit: "g", prep: null, corrects_food_name: null },
        ],
      } }] });
    }
    log.decide.push(String(body.messages[0].content));
    return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input: { meal_type: "lunch", drona_line: "ok", items: [] } }] });
  }) as typeof fetch;
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [{
      food_id: "row-boiled", name: "boiled chana", brand: null, base_unit: "g", kcal: 164, protein_g: 9, carb_g: 27, fat_g: 2.6, fiber_g: 7.6,
      servings: [{ label: "1 cup", grams: 164 }], source: "catalog",
    }],
    backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn, jev: { apiKey: "j", timeoutMs: 1000, fetchFn },
    userMemory: { load: async () => ({ entries: [boiled], timeZone: "Asia/Kolkata" }), lookupAliases: async () => [] },
  } as ParseMealDeps;
}

Deno.test("the failure this prevents: memory put boiled chana back after the user swapped it out", async () => {
  const log = { decide: [] as string[] };
  const r = await runParseMeal(deps(log), {
    text: "still suji halwa is duplicated and why are u taking boiled chana, when I said navaratri chana",
    previousText: "i had 3 pooris and chana navratri vaale in lunch and some 40g halwa suji vaala", previousItems: CARD,
    localHour: 18, mealHint: "lunch", recentFoods: [], todayTotals: null, targets: null,
  });
  assert(!r.tool_calls.includes("user_memory_match"), r.tool_calls.join(","));
  // Both drops are in the trace: memory and the catalog rows.
  const drops = r.steps.filter((s) => s.tool === "rejected_food").map((s) => (s.input as { from?: string }).from ?? "candidates");
  assertEquals(drops.sort(), ["candidates", "memory"]);
  // Neither memory nor the catalog row named "boiled chana" reaches decide for that line.
  assertEquals(log.decide.length, 1);
  const payload = JSON.parse(log.decide[0].split("\n")[0]) as { items?: Array<{ name: string; candidates?: Array<{ name: string }> }> };
  const chana = payload.items?.find((i) => /navratri/i.test(i.name));
  assert(chana, log.decide[0].slice(0, 400));
  assertEquals((chana!.candidates ?? []).map((c) => c.name).filter((n) => /boiled chana/i.test(n)), []);
  // The last step sees the message that first described the meal: a
  // correction's own words rarely say what the food is.
  assertEquals(JSON.parse(log.decide[0].split("\n")[0]).earlier_text,
    "i had 3 pooris and chana navratri vaale in lunch and some 40g halwa suji vaala");
  // And the card does not get the old line back.
  assertEquals((r.parsed?.items ?? []).filter((i) => i.food_name === "boiled chana").length, 0);
});

Deno.test("the same food named in another word order is the same rejected food", () => {
  const rows = [{ name: "Chana, boiled" }, { name: "Chole (Chana Masala)" }, { name: "boiled chana" }];
  assertEquals(withoutRejected(rows, "boiled chana", (r) => r.name).map((r) => r.name), ["Chole (Chana Masala)"]);
});

Deno.test("the rejected line's own catalog row goes, whatever the row is called", () => {
  const card = [prev("boiled chana", 75, "g", 75, 123, "row-7")];
  const rows = [{ food_id: "row-7", name: "Chickpeas, mature seeds, boiled" }, { food_id: "row-9", name: "Chole" }];
  assertEquals(withoutRejected(rows, "boiled chana", (r) => r.name, card).map((r) => r.food_id), ["row-9"]);
});

Deno.test("a first log carries no earlier_text", async () => {
  const log = { decide: [] as string[] };
  await runParseMeal(deps(log), {
    text: "75g navratri chana", localHour: 13, mealHint: null, recentFoods: [], todayTotals: null, targets: null,
  });
  assertEquals(log.decide.length, 1);
  assertEquals(JSON.parse(log.decide[0].split("\n")[0]).earlier_text, undefined);
});
