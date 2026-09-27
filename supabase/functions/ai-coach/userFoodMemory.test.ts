// Run with: deno test --allow-all supabase/functions/ai-coach/userFoodMemory.test.ts
//
// The user's own food memory (owner decision 2026-09-27): foods THIS user logged
// in the last 10 days answer their next log first, so the same person gets the
// same number every time. The rules pinned here are the owner's:
//   precise-logged numbers serve every tier; thorough serves thorough and fast;
//   an accepted Quick guess serves Quick only; the user's own numbers serve all.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildMemory,
  decideMemory,
  entryLevel,
  matchMemory,
  type MemoryEntry,
  type MemoryFood,
  memoryNote,
  servesTier,
  shortlist,
} from "./userFoodMemory.ts";
import { memoryQuickItem, type ParseMealDeps, runParseMeal } from "./parseMeal.ts";

const NOW = new Date("2026-09-27T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  food_name: "grilled chicken breast",
  food_id: null,
  kcal: 226, // 150 g at 151 per 100
  protein_g: 46.5,
  carb_g: 0,
  fat_g: 4.8,
  fiber_g: null,
  grams: 150,
  quantity: 150,
  serving_unit: "g",
  source: "catalog",
  logged_via: "ai",
  tier: "precise",
  logged_at: daysAgo(1),
  ...over,
});

// ── Where a remembered food may be reused ───────────────────────────────────

Deno.test("a Precise-logged food serves every tier", () => {
  const lvl = entryLevel(entry({ tier: "precise" }));
  assertEquals([servesTier(lvl, "fast"), servesTier(lvl, "thorough"), servesTier(lvl, "precise")], [true, true, true]);
});

Deno.test("the failure this prevents: a Quick guess answering a Precise log", () => {
  const lvl = entryLevel(entry({ tier: "fast", source: "estimate" }));
  assertEquals([servesTier(lvl, "fast"), servesTier(lvl, "thorough"), servesTier(lvl, "precise")], [true, false, false]);
});

Deno.test("a Thorough-logged food serves Thorough and Quick, not Precise", () => {
  const lvl = entryLevel(entry({ tier: "thorough" }));
  assertEquals([servesTier(lvl, "fast"), servesTier(lvl, "thorough"), servesTier(lvl, "precise")], [true, true, false]);
});

Deno.test("numbers the user typed or picked serve every tier", () => {
  assertEquals(entryLevel(entry({ tier: null, source: "manual" })), "precise");
  assertEquals(entryLevel(entry({ tier: null, logged_via: "manual", source: "catalog" })), "precise");
});

Deno.test("a line we cannot attribute counts as Quick, the safe side", () => {
  assertEquals(entryLevel(entry({ tier: null })), "fast");
});

// ── The memory itself ───────────────────────────────────────────────────────

Deno.test("only the last 10 days count", () => {
  const foods = buildMemory([entry({ logged_at: daysAgo(11) }), entry({ food_name: "paneer", logged_at: daysAgo(9) })], "fast", NOW);
  assertEquals(foods.map((f) => f.name), ["paneer"]);
});

Deno.test("frequent foods come first, then recent ones", () => {
  const foods = buildMemory([
    entry({ food_name: "banana", logged_at: daysAgo(0.1) }),
    entry({ food_name: "oats", logged_at: daysAgo(3) }),
    entry({ food_name: "oats", logged_at: daysAgo(5) }),
    entry({ food_name: "apple", logged_at: daysAgo(2) }),
  ], "fast", NOW);
  assertEquals(foods.map((f) => f.name), ["oats", "banana", "apple"]);
  assertEquals(foods[0].times, 2);
});

Deno.test("the newest numbers the user accepted are the ones remembered", () => {
  const foods = buildMemory([
    entry({ kcal: 250, logged_at: daysAgo(4) }),
    entry({ kcal: 226, logged_at: daysAgo(1) }),
  ], "precise", NOW);
  assertEquals(foods[0].per100.kcal, 150.7);
});

Deno.test("a food the parse's tier may not use is left out entirely", () => {
  const foods = buildMemory([entry({ tier: "fast" })], "precise", NOW);
  assertEquals(foods, []);
});

Deno.test("a line with no weight cannot give a per-100 and is left out", () => {
  assertEquals(buildMemory([entry({ grams: null })], "fast", NOW), []);
});

Deno.test("a unit the user logged in is kept as a serving", () => {
  const [egg] = buildMemory([entry({ food_name: "boiled egg", kcal: 155, grams: 100, quantity: 2, serving_unit: "piece" })], "fast", NOW);
  assertEquals(egg.serving, { label: "piece", grams: 50 });
});

Deno.test("with many foods, the closest names are the ones Jev sees", () => {
  const foods = buildMemory(
    Array.from({ length: 15 }, (_, i) => entry({ food_name: `food ${i} thing` })).concat(entry({ food_name: "grilled chicken breast" })),
    "fast",
    NOW,
  );
  const list = shortlist(foods, "grilled chicken", 5);
  assertEquals(list[0].name, "grilled chicken breast");
  assertEquals(list.length, 5);
});

// ── The decision ────────────────────────────────────────────────────────────

const food = (name: string, kcal: number, at = daysAgo(1)): MemoryFood => ({
  key: name, name, food_id: null, per100: { kcal, protein_g: 20, carb_g: 0, fat_g: 3, fiber_g: null },
  serving: null, source: "catalog", level: "precise", times: 1, last_logged_at: at,
});

Deno.test("below the floor nothing is served", () => {
  const d = decideMemory([food("chicken", 151)], [0.6]);
  assertEquals(d.food, null);
});

Deno.test("the failure this prevents: two remembered foods, a different number each time", () => {
  // Both clear the floor with different numbers: the one the user logged most
  // recently wins, every time, rather than whichever scored a hair higher.
  const older = food("grilled chicken breast", 176, daysAgo(5));
  const newer = food("chicken breast grilled", 151, daysAgo(1));
  assertEquals(decideMemory([older, newer], [0.97, 0.9]).food?.name, "chicken breast grilled");
  assertEquals(decideMemory([older, newer], [0.9, 0.97]).food?.name, "chicken breast grilled");
});

Deno.test("Jev down: no answer, never a throw", async () => {
  const r = await matchMemory(
    { apiKey: "k", timeoutMs: 100, fetchFn: (async () => new Response("x", { status: 500 })) as typeof fetch },
    [food("chicken", 151)],
    { name: "chicken", brand: null },
  );
  assertEquals(r.food, null);
});

Deno.test("the card names the day in the user's own zone", () => {
  // 20:00 UTC on the 26th is 01:30 on the 27th in India.
  const f = food("x", 1, "2026-09-26T20:00:00Z");
  assertEquals(memoryNote(f, "Asia/Kolkata"), "Same as you logged on Sep 27");
  assertEquals(memoryNote(f, null), "Same as you logged on Sep 26");
});

// ── Quick lines built from memory ───────────────────────────────────────────

Deno.test("a typed weight is the weight, at the remembered numbers", () => {
  const it = memoryQuickItem(food("grilled chicken breast", 151), { name: "grilled chicken", brand: null, quantity: 200, unit: "g" })!;
  assertEquals([it.grams, it.kcal], [200, 302]);
});

Deno.test("a unit the user logged in before converts exactly", () => {
  const egg = { ...food("boiled egg", 155), serving: { label: "piece", grams: 50 } };
  const it = memoryQuickItem(egg, { name: "eggs", brand: null, quantity: 3, unit: "pieces", est: { total_g: 999 } })!;
  assertEquals(it.grams, 150);
});

Deno.test("no weight and no estimate: the memory is not used rather than guessed", () => {
  assertEquals(memoryQuickItem(food("x", 100), { name: "x", brand: null, quantity: 1, unit: "bowl" }), null);
});

// ── End to end: every tier asks the memory first ────────────────────────────

/** Fake network: Jev scores remembered rows by name; the model extracts one
 *  line and decides it onto whatever candidate id it is shown. */
function net(opts: { scores: Record<string, number>; calls: string[]; line: Record<string, unknown> }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.includes("typesafe.ai")) {
      opts.calls.push("jev");
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(body.questions as Record<string, { instructions: string }>)) {
        const name = /Logged before: (.+?)\. A match/.exec(q.instructions)?.[1] ?? "";
        const p = opts.scores[name] ?? 0;
        answers[k] = { type: "score", probabilities: { "0": 1 - p, "1": 0, "2": p }, confidence: p };
      }
      return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    const tools: string[] = (body.tools ?? []).map((t: { name: string }) => t.name);
    const name = tools[0] ?? "";
    opts.calls.push(name);
    if (name === "estimate_meal" || name === "extract_meal") {
      return Response.json({
        stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", name, input: { declined: false, meal_type_from_text: null, items: [opts.line] } }],
      });
    }
    if (name === "report_sources") {
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name, input: { results: [] } }] });
    }
    // decide: take the first candidate id it was shown.
    const text = JSON.stringify(body.messages ?? []);
    const id = /"food_id\\?":\\?"(fs:mem_[^"\\]+)/.exec(text)?.[1] ?? null;
    return Response.json({
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name, input: {
        meal_type: "lunch", drona_line: "ok",
        items: [{ food_name: "grilled chicken breast", food_id: id, quantity: 150, serving_label: "g", grams: 150, kcal: 226, protein_g: 46.5, carb_g: 0, fat_g: 4.8, confidence: "high", assumption: null }],
      } }],
    });
  }) as typeof fetch;
}

/** The pipeline reads the real clock, so end-to-end entries are dated from it. */
const liveAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const live = (over: Partial<MemoryEntry> = {}) => entry({ logged_at: liveAgo(1), ...over });

function deps(entries: MemoryEntry[], scores: Record<string, number>, calls: string[], lookups: string[], line: Record<string, unknown>): ParseMealDeps {
  const fetchFn = net({ scores, calls, line });
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async (q) => { lookups.push(`search:${q}`); return []; },
    backfillOffFood: async () => null,
    getFoodPer100: async () => null,
    preciseCacheGet: async (k) => { lookups.push(`precise:${k}`); return null; },
    jev: { apiKey: "jev", timeoutMs: 1000, fetchFn },
    userMemory: { load: () => Promise.resolve({ entries, timeZone: "Asia/Kolkata" }) },
    fetchFn,
  };
}

const EXTRACTED = { name: "grilled chicken breast", brand: null, quantity: 150, unit: "g", prep: null };
const ESTIMATED = {
  ...EXTRACTED, label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null,
  est_kcal: 260, est_protein_g: 45, est_carb_g: 0, est_fat_g: 9, est_total_g: 150,
};
const BASE = { localHour: 13, mealHint: null, recentFoods: [], todayTotals: null, targets: null };

Deno.test("Precise: a remembered food answers, and no other source is asked", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live()], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED),
    { ...BASE, text: "150g grilled chicken breast", mode: "super" },
  );
  assert(r.tool_calls.includes("user_memory_match"), JSON.stringify(r.tool_calls));
  assertEquals(lookups, []);
  assert(!calls.includes("report_sources"));
  const item = r.parsed!.items[0];
  assertEquals(item.assumption, memoryNote({ ...food("x", 1), last_logged_at: liveAgo(1) }, "Asia/Kolkata"));
  assertEquals(item.numbers_tier, "precise");
  assertEquals(item.food_id, null);
});

Deno.test("Precise: a remembered Quick guess is not used", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live({ tier: "fast", source: "estimate" })], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED),
    { ...BASE, text: "150g grilled chicken breast", mode: "super" },
  );
  assert(!r.tool_calls.includes("user_memory_match"));
  assert(lookups.some((l) => l.startsWith("precise:")));
});

Deno.test("Thorough: a remembered food answers before the catalog", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live({ tier: "thorough" })], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED),
    { ...BASE, text: "150g grilled chicken breast", mode: null },
  );
  assert(r.tool_calls.includes("user_memory_match"));
  assertEquals(lookups, []);
});

Deno.test("Quick: the remembered numbers replace the model's guess", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live({ tier: "precise" })], { "grilled chicken breast": 0.97 }, calls, lookups, ESTIMATED),
    { ...BASE, text: "150g grilled chicken breast", mode: "fast" },
  );
  const item = r.parsed!.items[0];
  assertEquals([item.kcal, item.grams, item.numbers_tier], [226.1, 150, "precise"]);
  assertEquals(item.assumption, memoryNote({ ...food("x", 1), last_logged_at: liveAgo(1) }, "Asia/Kolkata"));
  assertEquals(lookups, []);
});

Deno.test("Quick: an accepted Quick guess is reused in Quick", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live({ tier: "fast", source: "estimate" })], { "grilled chicken breast": 0.97 }, calls, lookups, ESTIMATED),
    { ...BASE, text: "150g grilled chicken breast", mode: "fast" },
  );
  assertEquals(r.parsed!.items[0].numbers_tier, "fast");
  assertEquals(r.parsed!.items[0].source, "estimate");
});

Deno.test("Quick: an unsure match keeps the model's own estimate", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live()], { "grilled chicken breast": 0.5 }, calls, lookups, ESTIMATED),
    { ...BASE, text: "150g grilled chicken breast", mode: "fast" },
  );
  assertEquals(r.parsed!.items[0].kcal, 260);
  assertEquals(r.parsed!.items[0].source, "estimate");
});

Deno.test("a follow-up turn never asks the memory: that is where 'double check' lives", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live()], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED),
    {
      ...BASE, text: "double check the chicken", mode: "super",
      previousItems: [{ food_name: "grilled chicken breast", quantity: 150, serving_label: "g", grams: 150, kcal: 226, protein_g: 46.5, carb_g: 0, fat_g: 4.8, food_id: null, source: "catalog" } as never],
    },
  ).catch(() => null);
  assert(!calls.includes("jev") || !(r?.steps ?? []).some((s) => s.tool === "user_memory"));
  assert(!(r?.tool_calls ?? []).includes("user_memory_match"));
});

Deno.test("Quick: remembered numbers at an absurd amount are flagged, like an estimate would be", async () => {
  // Reviewer on #220: a mistyped "2000g" of a remembered 600 kcal/100 g food
  // shipped at high confidence, past the guard every estimate goes through.
  const calls: string[] = [], lookups: string[] = [];
  const nuts = live({ food_name: "peanut butter", kcal: 600, protein_g: 25, carb_g: 20, fat_g: 50, grams: 100, quantity: 100 });
  const r = await runParseMeal(
    deps([nuts], { "peanut butter": 0.97 }, calls, lookups, { ...ESTIMATED, name: "peanut butter", quantity: 2000, est_total_g: 2000 }),
    { ...BASE, text: "2000g peanut butter", mode: "fast" },
  );
  const item = r.parsed!.items[0];
  assertEquals(item.kcal, 12000);
  assertEquals(item.confidence, "low");
});

Deno.test("a follow-up turn never even reads the user's log", async () => {
  // Reviewer on #220: the 10-day read ran on every parse and was thrown away on
  // follow-ups. It is now started only for a first-shot log.
  let reads = 0;
  const calls: string[] = [], lookups: string[] = [];
  const d = deps([live()], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED);
  d.userMemory = { load: () => { reads++; return Promise.resolve({ entries: [live()], timeZone: null }); } };
  await runParseMeal(d, {
    ...BASE, text: "double check the chicken", mode: "super",
    previousItems: [{ food_name: "grilled chicken breast", quantity: 150, serving_label: "g", grams: 150, kcal: 226, protein_g: 46.5, carb_g: 0, fat_g: 4.8, food_id: null, source: "catalog" } as never],
  }).catch(() => null);
  assertEquals(reads, 0);
});

Deno.test("the failure this prevents: an older food dropped before Jev could see it", () => {
  // Live data, 2026-09-27: 30+ newer foods pushed a 6-day-old Precise
  // "raw chicken breast" out of the list, so Precise never matched it.
  const newer = Array.from({ length: 40 }, (_, i) => entry({ food_name: `snack ${i}`, logged_at: daysAgo(0.1 + i * 0.01) }));
  const chicken = entry({ food_name: "raw chicken breast", logged_at: daysAgo(6) });
  const foods = buildMemory([...newer, chicken], "precise", NOW);
  assertEquals(shortlist(foods, "raw chicken breast", 5)[0].name, "raw chicken breast");
});
