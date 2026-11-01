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
  respellForJev,
  brandApart,
  memoryQuestions,
  memoryChoiceQuestion,
  MEMORY_CHOICE_NONE,
  servesTier,
  shortlist,
} from "./userFoodMemory.ts";
import { memoryLineName, memoryQuickItem, type ParseMealDeps, runParseMeal } from "./parseMeal.ts";

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
function net(opts: { scores: Record<string, number>; calls: string[]; line: Record<string, unknown>; extraction?: Record<string, unknown> }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.includes("typesafe.ai")) {
      opts.calls.push(`jev:${body.state?.foods?.[0]?.name ?? ""}`);
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(body.questions as Record<string, { instructions: string }>)) {
        const name = /Candidate previously logged by this user: (.+)\.$/.exec(q.instructions)?.[1] ?? "";
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
        content: [{ type: "tool_use", name, input: { declined: false, meal_type_from_text: null, items: [opts.line], ...opts.extraction } }],
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

function deps(entries: MemoryEntry[], scores: Record<string, number>, calls: string[], lookups: string[], line: Record<string, unknown>, extraction?: Record<string, unknown>): ParseMealDeps {
  const fetchFn = net({ scores, calls, line, extraction });
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

Deno.test("Quick: a maybe match (0.6 to 0.7) keeps the model's own estimate", async () => {
  // A maybe needs decide to judge it, and Quick has no decide.
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live()], { "grilled chicken breast": 0.65 }, calls, lookups, ESTIMATED),
    { ...BASE, text: "150g grilled chicken breast", mode: "fast" },
  );
  assertEquals(r.parsed!.items[0].kcal, 260);
  assertEquals(r.parsed!.items[0].source, "estimate");
});

Deno.test("an explicit research request never asks memory for the answer being challenged", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live()], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED, { requests_research: true, items: [] }),
    {
      ...BASE, text: "double check the chicken", mode: "super",
      previousItems: [{ food_name: "grilled chicken breast", quantity: 150, serving_label: "g", grams: 150, kcal: 226, protein_g: 46.5, carb_g: 0, fat_g: 4.8, food_id: null, source: "catalog" } as never],
    },
  ).catch(() => null);
  assert(!calls.some((c) => c.startsWith("jev")) || !(r?.steps ?? []).some((s) => s.tool === "user_memory"));
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

Deno.test("an explicit research request never reads history only to discard it", async () => {
  let reads = 0;
  const calls: string[] = [], lookups: string[] = [];
  const d = deps([live()], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED, { requests_research: true, items: [] });
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

Deno.test("the preparation is part of what the memory compares", () => {
  assertEquals(memoryLineName({ name: "chicken breast", prep: "grilled" }), "grilled chicken breast");
  assertEquals(memoryLineName({ name: "grilled chicken breast", prep: "grilled" }), "grilled chicken breast");
  assertEquals(memoryLineName({ name: "chicken breast", prep: null }), "chicken breast");
});

Deno.test("the failure this prevents: Quick splits 'grilled' out of the name and misses the memory", async () => {
  // Sim test 2026-09-27: Quick extracted name "chicken breast", prep "grilled";
  // Jev was asked about plain "chicken breast" and refused the grilled row.
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live()], { "grilled chicken breast": 0.97 }, calls, lookups, { ...ESTIMATED, name: "chicken breast", prep: "grilled" }),
    { ...BASE, text: "150g grilled chicken breast", mode: "fast" },
  );
  assert(calls.includes("jev:grilled chicken breast"), JSON.stringify(calls));
  assertEquals(r.parsed!.items[0].numbers_tier, "precise");
});

Deno.test("the trace says when the memory had nothing this tier may use", async () => {
  // A Precise parse for a user whose foods are all Quick guesses used to leave
  // no user_memory step at all, which read the same as "never ran".
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live({ tier: "fast", source: "estimate" })], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED),
    { ...BASE, text: "150g grilled chicken breast", mode: "super" },
  );
  const step = r.steps.find((s) => s.tool === "user_memory");
  assertEquals((step?.result as { decision: { reason: string } }).decision.reason, "no_usable_foods");
  assertEquals((step?.result as { logged_lines: number }).logged_lines, 1);
});

Deno.test("the trace says why a research request skipped memory", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps([live()], { "grilled chicken breast": 0.97 }, calls, lookups, EXTRACTED, { requests_research: true, items: [] }),
    {
      ...BASE, text: "double check the chicken", mode: "super",
      previousItems: [{ food_name: "grilled chicken breast", quantity: 150, serving_label: "g", grams: 150, kcal: 226, protein_g: 46.5, carb_g: 0, fat_g: 4.8, food_id: null, source: "catalog" } as never],
    },
  ).catch(() => null);
  const step = (r?.steps ?? []).find((s) => s.tool === "user_memory");
  assertEquals((step?.result as { skipped: string }).skipped, "research_requested");
});

Deno.test("one alias on two rows: the row named as typed wins, whichever is newer", async () => {
  // Was a millisecond race: both rows confirmed as "cucumber", tied on times
  // and trust, so the newer won. The incident replay test flaked on it.
  const plain = { ...food("cucumber", 16, daysAgo(2)), confirmed_aliases: ["cucumber"] };
  const raw = { ...food("Cucumber, raw", 15, daysAgo(1)), confirmed_aliases: ["cucumber"] };
  const down = { apiKey: "jev", timeoutMs: 1000, fetchFn: (async () => new Response("down", { status: 503 })) as typeof fetch };
  for (const order of [[plain, raw], [raw, plain]]) {
    const m = await matchMemory(down, order, { name: "cucumber", brand: null });
    assertEquals(m.food?.name, "cucumber");
  }
});

Deno.test("confirmed aliases resolve without Jev, even when it is down", async () => {
  let requests = 0;
  const oats = { ...food("Doctor's Choice banana caramel protein oats", 427.3), confirmed_aliases: ["doctors banana caramel oats"] };
  const r = await matchMemory({ apiKey: "k", timeoutMs: 100, fetchFn: (() => { requests++; throw Error("offline"); }) as typeof fetch },
    [oats], { name: "DOCTORS banana-caramel oats", brand: null });
  assertEquals(r.food?.name, oats.name);
  assertEquals(r.trace.path, "confirmed_alias");
  assertEquals(requests, 0);
});

Deno.test("an alias checks explicit brand and preparation too", async () => {
  const remembered = { ...food("grilled Brand A chicken", 151), confirmed_aliases: ["Brand A chicken"] };
  let requests = 0;
  const d = { apiKey: "k", timeoutMs: 100, fetchFn: (async () => { requests++; return new Response("down", { status: 500 }); }) as typeof fetch };
  assertEquals((await matchMemory(d, [remembered], { name: "chicken", brand: "Brand B" })).food, null);
  assertEquals((await matchMemory(d, [remembered], { name: "raw Brand A chicken", brand: null })).food, null);
  assertEquals(requests, 2);
});

Deno.test("the same alias on two products picks the one the user logs most, and names the other", async () => {
  const list = [{ ...food("Brand banana protein oats", 400), times: 1 }, { ...food("Brand banana regular oats", 400), times: 4 }]
    .map((f) => ({ ...f, confirmed_aliases: ["brand banana oats"] }));
  const r = await matchMemory({ apiKey: "", timeoutMs: 1 }, list, { name: "brand banana oats", brand: null });
  assertEquals(r.food?.name, "Brand banana regular oats");
  assertEquals(r.food?.also, ["Brand banana protein oats"]);
  assertEquals(decideMemory(list, [0.98, 0.99]).food?.name, "Brand banana regular oats");
});

Deno.test("an exact alias cannot disappear behind the top-ten shortlist", async () => {
  const target = { ...food("Long canonical packaged product name", 100), confirmed_aliases: ["my cereal"] };
  const list = Array.from({ length: 20 }, (_, i) => food(`my cereal ${i}`, 100)).concat(target);
  const r = await matchMemory({ apiKey: "", timeoutMs: 1 }, list, { name: "my cereal", brand: null });
  assertEquals(r.food?.name, target.name);
});

Deno.test("durable confirmed foods survive ten days without upgrading their tier", () => {
  const cached = entry({ logged_at: daysAgo(60), persistent: true, confirmed_aliases: ["my chicken"], tier: "fast", source: "estimate" });
  assertEquals(buildMemory([cached], "fast", NOW)[0].confirmed_aliases, ["my chicken"]);
  assertEquals(buildMemory([cached], "precise", NOW), []);
});

Deno.test("an exact alias DB lookup survives the 300-food memory bound", () => {
  const cache = Array.from({ length: 301 }, (_, i) => entry({ food_name: `recent food ${i}`, logged_at: daysAgo(1) }));
  const alias = entry({ food_name: "older canonical product", logged_at: daysAgo(60), persistent: true, alias_lookup: true, confirmed_aliases: ["my cereal"] });
  const result = buildMemory([...cache, alias], "precise", NOW);
  assert(result.some((f) => f.name === alias.food_name));
  assertEquals(result.length, 300);
});

Deno.test("new shorthand questions name the input and each candidate explicitly", async () => {
  const oats = food("Doctor's Choice banana caramel protein oats", 427.3);
  let state: { remembered_foods?: unknown[] } | undefined;
  const r = await matchMemory({ apiKey: "k", timeoutMs: 100, fetchFn: (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    state = body.state;
    assert(body.questions.m1.instructions.includes("Input food: doctors banana caramel oats."));
    assert(body.questions.m1.instructions.includes(`Candidate previously logged by this user: ${oats.name}.`));
    assert(body.questions.m1.instructions.includes("unspecified, not contradictory"));
    return Response.json({ answers: { m1: { type: "score", probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 } } } });
  }) as typeof fetch }, [oats], { name: "doctors banana caramel oats", brand: null });
  assertEquals(r.food?.name, oats.name);
  assertEquals(state?.remembered_foods, undefined);
});

Deno.test("Jev unsure on every row: no memory, and the meal is never blocked", async () => {
  const list = [food("Brand protein oats", 400), food("Brand regular oats", 400)];
  const r = await matchMemory({ apiKey: "k", timeoutMs: 100, fetchFn: (async () => Response.json({ answers: {
    m1: { type: "score", probabilities: { "0": 0.01, "1": 0.95, "2": 0.04 } },
    m2: { type: "score", probabilities: { "0": 0.01, "1": 0.95, "2": 0.04 } },
  } })) as typeof fetch }, list, { name: "Brand oats", brand: null });
  assertEquals(r.food, null);
  assertEquals((r.trace.decision as { reason: string }).reason, "below_floor");
});

Deno.test("confirmed alias repeat scales the new portion and carries save-only evidence", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const canonical = "Doctor's Choice banana caramel protein oats";
  const cached = live({ food_name: canonical, kcal: 427.3, grams: 100, protein_g: 24, carb_g: 60, fat_g: 10, persistent: true,
    logged_at: liveAgo(60), confirmed_aliases: ["doctors banana caramel oats"] });
  const r = await runParseMeal(deps([cached], {}, calls, lookups,
    { ...ESTIMATED, name: "doctors banana caramel oats", quantity: 20, est_total_g: 20 }),
    { ...BASE, text: "20g doctors banana caramel oats", mode: "fast" });
  const item = r.parsed!.items[0];
  assertEquals([item.food_name, item.grams, item.kcal, item.numbers_tier], [canonical, 20, 85.5, "precise"]);
  assertEquals(item.memory_input_name, "doctors banana caramel oats");
  assert(!calls.some((c) => c.startsWith("jev:")));
  assertEquals(lookups, []);
});

Deno.test("the failure this prevents: an alias on two products blocked the whole meal", async () => {
  // Live 2026-10-05..09: "more than one saved match" refused whole meals, and
  // the user's answers ("choose any", "first one") never released them.
  const calls: string[] = [], lookups: string[] = [];
  const entries = ["Brand banana protein oats", "Brand banana regular oats"].map((food_name) => live({ food_name, confirmed_aliases: ["brand banana oats"] }));
  const r = await runParseMeal(deps(entries, {}, calls, lookups, { ...ESTIMATED, name: "brand banana oats" }),
    { ...BASE, text: "20g brand banana oats", mode: "fast" });
  assertEquals(r.declined, null);
  assert(r.parsed!.items[0].food_name.startsWith("Brand banana"));
  assert(r.parsed!.items[0].assumption!.includes("You also log"), r.parsed!.items[0].assumption!);
});

// ── Identity only (owner decision 2026-10-11) ───────────────────────────────
//
// Jev judges whether a remembered food IS the food the user means, nothing
// else. Choosing between several that are, and whose numbers to use, is code.

Deno.test("Jev is asked about identity only, never whether another row also fits", async () => {
  let body: { state: { remembered_foods?: unknown[] }; questions: Record<string, { instructions: string; criteria: string[] }> } | undefined;
  await matchMemory({ apiKey: "k", timeoutMs: 100, fetchFn: (async (_u, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ answers: {} });
  }) as typeof fetch }, [food("cucumber", 12.5), food("cucumbers", 10.7)], { name: "cucumber", brand: null });
  const q = body!.questions.m1;
  assert(!/equally fits|choose unresolved|more than one remembered product fits/i.test(q.instructions + q.criteria.join(" ")), q.instructions);
  assert(q.criteria[1].startsWith("Unclear"), q.criteria[1]);
  assert(q.criteria[2].startsWith("Same"), q.criteria[2]);
  // Other remembered foods are not in the state: they cannot pull an answer
  // from "same" to "unclear".
  assertEquals(body!.state.remembered_foods, undefined);
});

Deno.test("the failure this prevents: one food saved under three names was 'ambiguous'", () => {
  // Her real rows, 2026-10-06: cucumber 7 times, the other two once each.
  const list = [
    { ...food("cucumber", 12.5), times: 7 },
    { ...food("cucumbers", 10.7), times: 1 },
    { ...food("Cucumber, raw", 16), times: 1 },
  ];
  const d = decideMemory(list, [0.9, 0.88, 0.8]);
  assertEquals(d.food?.name, "cucumber");
  // The same food under other names is not a choice worth showing the user.
  assertEquals(d.food?.also, []);
});

Deno.test("real variants: the one the user logs most, with the other named on the card", () => {
  const list = [{ ...food("vanilla whey", 380), times: 1 }, { ...food("chocolate whey", 390), times: 3 }];
  const d = decideMemory(list, [0.9, 0.9]);
  assertEquals(d.food?.name, "chocolate whey");
  assertEquals(d.food?.also, ["vanilla whey"]);
  assertEquals(memoryNote(d.food!, null), "Same as you logged on Sep 26. You also log vanilla whey; if it was that, just say so.");
});

Deno.test("a variant just under the floor competes when its sibling cleared it", () => {
  // Real Jev for "whey": chocolate 0.73, vanilla 0.91. She logs chocolate more.
  const list = [{ ...food("chocolate whey", 390), times: 3 }, { ...food("vanilla whey", 380), times: 1 }];
  const d = decideMemory(list, [0.73, 0.91]);
  assertEquals(d.food?.name, "chocolate whey");
  assertEquals(d.food?.also, ["vanilla whey"]);
  // With no sibling over the floor, a score under it still serves nothing.
  assertEquals(decideMemory([list[0]], [0.65]).food, null);
  // 0.73 alone clears the 0.7 floor (owner decision 2026-10-31).
  assertEquals(decideMemory([list[0]], [0.73]).food?.name, "chocolate whey");
});

Deno.test("when the user names the variant, habit cannot swap it for the sibling they log more", () => {
  // "vanilla whey" typed, chocolate (logged 9 times) at 0.6.
  const list = [{ ...food("chocolate whey", 390), times: 9 }, { ...food("vanilla whey", 380), times: 1 }];
  assertEquals(decideMemory(list, [0.6, 0.95], undefined, "vanilla whey").food?.name, "vanilla whey");
  // Plain "whey" names neither, so habit still decides.
  assertEquals(decideMemory(list, [0.6, 0.95], undefined, "whey").food?.name, "chocolate whey");
});

Deno.test("a named variant wins even when the other variant also clears the floor", () => {
  // Jev is noisy near 0.75: chocolate at 0.76 must not win on habit when the
  // user typed vanilla, and must not be named on the card either.
  const list = [{ ...food("chocolate whey", 390), times: 9 }, { ...food("vanilla whey", 380), times: 1 }];
  const d = decideMemory(list, [0.76, 0.95], undefined, "vanilla whey");
  assertEquals(d.food?.name, "vanilla whey");
  assertEquals(d.food?.also, []);
  // Only the ruled-out sibling is above the floor: nothing is served.
  assertEquals(decideMemory(list, [0.8, 0.4], undefined, "vanilla whey").food, null);
});

Deno.test("the row named exactly as typed beats a longer name logged more", () => {
  const list = [{ ...food("protein oats", 400), times: 10 }, { ...food("oats", 380), times: 1 }];
  assertEquals(decideMemory(list, [0.8, 0.99], undefined, "oats").food?.name, "oats");
  // Plurals count as the same words; habit still picks among exact names.
  const cuke = [{ ...food("cucumbers", 10.7), times: 1 }, { ...food("cucumber", 12.5), times: 7 }, { ...food("Cucumber, raw", 16), times: 9 }];
  assertEquals(decideMemory(cuke, [0.9, 0.9, 0.9], undefined, "cucumber").food?.name, "cucumber");
});

Deno.test("'it was vanilla' after a chocolate pick serves the vanilla the user logged", async () => {
  // The card named the other variant; the user's correction must reach it, not be
  // swallowed by the same habit pick.
  const calls: string[] = [], lookups: string[] = [];
  const entries = [
    ...[3, 2, 1].map((d) => live({ food_name: "chocolate whey", kcal: 117, grams: 30, quantity: 30, logged_at: liveAgo(d) })),
    live({ food_name: "vanilla whey", kcal: 114, grams: 30, quantity: 30, logged_at: liveAgo(4) }),
  ];
  const previous = [{
    food_id: null, food_name: "chocolate whey", quantity: 30, serving_label: "g", grams: 30,
    kcal: 117, protein_g: 24, carb_g: 3, fat_g: 1.5, fiber_g: null, source: "catalog" as const, meal_type: "snack" as const,
  }];
  const r = await runParseMeal(
    deps(entries, { "vanilla whey": 0.95, "chocolate whey": 0.02 }, calls, lookups,
      { ...ESTIMATED, name: "vanilla whey", quantity: 30, unit: "g", corrects_food_name: "chocolate whey", est_total_g: 30 },
      { corrects_previous: true }),
    { ...BASE, text: "it was vanilla whey", mode: "fast", previousText: "30g whey", previousItems: previous },
  );
  const names = r.parsed!.items.map((i) => i.food_name);
  assert(names.includes("vanilla whey"), JSON.stringify(names));
  assert(!names.includes("chocolate whey"), JSON.stringify(names));
  // Served from the user's memory (the decide in this harness writes its own numbers).
  assert(r.parsed!.items.find((i) => i.food_name === "vanilla whey")!.assumption!.startsWith("Same as you logged"));
});

Deno.test("a food under the floor that is not a variant never wins on habit", () => {
  // She logs casein far more, but Jev gave it 0.6 for "whey": it is not a
  // variant of the whey that cleared the floor, so it stays out.
  const list = [{ ...food("chocolate whey", 390), times: 1 }, { ...food("casein", 370), times: 9 }];
  const d = decideMemory(list, [0.9, 0.6]);
  assertEquals(d.food?.name, "chocolate whey");
  assertEquals(d.food?.also, []);
});

Deno.test("synonyms are not variants: 'Veggies' is served without naming 'vegetables'", () => {
  const list = [{ ...food("Veggies", 70), times: 3 }, food("vegetables", 40), food("Mixed vegetables", 60)];
  const d = decideMemory(list, [0.99, 0.97, 0.9]);
  assertEquals(d.food?.name, "Veggies");
  assertEquals(d.food?.also, []);
});

Deno.test("among foods logged as often, the user's own numbers beat a Quick guess", () => {
  const list = [
    { ...food("whole eggs", 155), level: "fast" as const, trust: 1 },
    { ...food("whole egg", 143), level: "precise" as const, trust: 4 },
  ];
  assertEquals(decideMemory(list, [0.9, 0.9]).food?.name, "whole egg");
});

Deno.test("the failure this prevents: a newer Quick guess replaced the user's own number", () => {
  // Live: the user's own 12.5 kcal/100 g cucumber (28 Sep) was replaced by a 6.3 Quick
  // guess (4 Oct) because the newest line always won.
  const [cucumber] = buildMemory([
    entry({ food_name: "cucumber", kcal: 30, grams: 240, quantity: 2, serving_unit: "whole", source: "manual", tier: "fast", logged_at: daysAgo(5) }),
    entry({ food_name: "cucumber", kcal: 19, grams: 300, quantity: 1, serving_unit: "piece", source: "estimate", tier: "fast", logged_at: daysAgo(1) }),
  ], "fast", NOW);
  assertEquals(cucumber.per100.kcal, 12.5);
  assertEquals(cucumber.times, 2);
});

Deno.test("a Precise number is not replaced by a newer Quick guess", () => {
  const [egg] = buildMemory([
    entry({ food_name: "whole egg", kcal: 143, grams: 100, tier: "precise", source: "catalog", logged_at: daysAgo(4) }),
    entry({ food_name: "whole egg", kcal: 160, grams: 100, tier: "fast", source: "estimate", logged_at: daysAgo(1) }),
  ], "fast", NOW);
  assertEquals(egg.per100.kcal, 143);
});

Deno.test("the trace keeps all three of Jev's chances for every row", async () => {
  const r = await matchMemory({ apiKey: "k", timeoutMs: 100, fetchFn: (async () => Response.json({ answers: {
    m1: { type: "score", probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
  } })) as typeof fetch }, [food("whole egg", 143)], { name: "whole egg", brand: null });
  const row = (r.trace.rows as Array<Record<string, number>>)[0];
  assertEquals([row.different, row.unclear, row.same], [0.1, 0.2, 0.7]);
});

Deno.test("a meal with one unclear food logs every food, the unclear one from its normal source", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const entries = ["cucumber", "cucumbers"].map((food_name) => live({ food_name, kcal: 30, grams: 240, tier: "fast", source: "estimate" }));
  // Jev unsure about both rows.
  const r = await runParseMeal(deps(entries, { cucumber: 0.3, cucumbers: 0.3 }, calls, lookups,
    { ...ESTIMATED, name: "cucumber", quantity: 2, unit: "whole", est_kcal: 30, est_protein_g: 1.5, est_carb_g: 7, est_fat_g: 0.2, est_total_g: 600 }),
    { ...BASE, text: "2 cucumbers", mode: "fast" });
  assertEquals(r.declined, null);
  assertEquals(r.parsed!.items[0].source, "estimate");
});

Deno.test("a later confirmation on a past diary day keeps its alias and corrected nutrition", () => {
  const cached = entry({ kcal: 250, persistent: true, logged_at: daysAgo(5), confirmed_at: daysAgo(0), confirmed_aliases: ["my chicken"] });
  const recent = entry({ kcal: 226, logged_at: daysAgo(1) });
  const remembered = buildMemory([cached, recent], "precise", NOW)[0];
  assertEquals(remembered.per100.kcal, 166.7);
  assertEquals(remembered.confirmed_aliases, ["my chicken"]);
});

// ── The one-tap swap chip ───────────────────────────────────────────────────
// The card names the other variant ("You also log vanilla whey"). The chip lets
// the user swap to it in one tap, so each line carries that variant already
// priced at the line's weight, from the user's own numbers. No model call.

const WHEY_ENTRIES = () => [
  ...[3, 2, 1].map((d) => live({ food_name: "chocolate whey", kcal: 117, protein_g: 24, carb_g: 3, fat_g: 1.5, grams: 30, quantity: 30, logged_at: liveAgo(d) })),
  live({ food_name: "vanilla whey", kcal: 114, protein_g: 23, carb_g: 3, fat_g: 1.5, grams: 30, quantity: 30, logged_at: liveAgo(4) }),
];
const WHEY_LINE = { ...ESTIMATED, name: "whey", quantity: 40, unit: "g", est_total_g: 40 };

Deno.test("the decision keeps the other variant's row, not just its name", () => {
  const list = [{ ...food("vanilla whey", 380), times: 1 }, { ...food("chocolate whey", 390), times: 3 }];
  const d = decideMemory(list, [0.9, 0.9]);
  assertEquals(d.food?.also, ["vanilla whey"]);
  assertEquals(d.food?.alsoFoods?.map((f) => [f.name, f.per100.kcal]), [["vanilla whey", 380]]);
});

for (const [tier, mode] of [["Quick", "fast"], ["Thorough", null], ["Precise", "super"]] as const) {
  Deno.test(`${tier}: the line carries the other variant at its own weight, from the user's numbers`, async () => {
    const calls: string[] = [], lookups: string[] = [];
    const r = await runParseMeal(
      deps(WHEY_ENTRIES(), { "chocolate whey": 0.9, "vanilla whey": 0.9 }, calls, lookups, WHEY_LINE),
      { ...BASE, text: "40g whey", mode, variantChips: true },
    );
    const item = r.parsed!.items[0];
    assertEquals(item.food_name, "chocolate whey");
    // The line's own weight (40 g typed; this harness's decide answers 150 g),
    // never the 30 g logged before. Vanilla is 380 kcal per 100 g.
    const g = item.grams;
    assert(g !== 30, String(g));
    assertEquals(item.alternatives?.map((a) => [a.food_name, a.grams, a.kcal]), [["vanilla whey", g, Math.round(380 * g / 10) / 10]]);
    assertEquals(item.alternatives?.[0].numbers_tier, "precise");
    assert(item.alternatives![0].assumption!.startsWith("Same as you logged on"), item.alternatives![0].assumption!);
    // The chip names it, so the note no longer asks the user to type it.
    assert(!item.assumption!.includes("You also log"), item.assumption!);
  });
}

Deno.test("an older build without the chip still gets the sentence that names the other variant", async () => {
  const r = await runParseMeal(
    deps(WHEY_ENTRIES(), { "chocolate whey": 0.9, "vanilla whey": 0.9 }, [], [], WHEY_LINE),
    { ...BASE, text: "40g whey", mode: "fast" },
  );
  assert(r.parsed!.items[0].assumption!.endsWith("You also log vanilla whey; if it was that, just say so."));
});

Deno.test("a food with no other variant offers no chip", async () => {
  const r = await runParseMeal(
    deps(WHEY_ENTRIES().slice(0, 3), { "chocolate whey": 0.9 }, [], [], WHEY_LINE),
    { ...BASE, text: "40g whey", mode: "fast", variantChips: true },
  );
  assertEquals(r.parsed!.items[0].alternatives, undefined);
});

// ── Review fixes, 2026-10-11 ────────────────────────────────────────────────

Deno.test("an exact name keeps its word order: 'chocolate milk' is not exactly 'milk chocolate'", () => {
  // Jev decides whether both are the food meant. If it lets both through, the
  // literal name must not hand the win to the reversed one logged more often.
  const list = [{ ...food("milk chocolate", 535), times: 9 }, { ...food("chocolate milk", 83), times: 1 }];
  assertEquals(decideMemory(list, [0.9, 0.9], undefined, "chocolate milk").food?.name, "chocolate milk");
});

Deno.test("a confirmed alias is not overruled by the variant rule, and never throws", async () => {
  // Both rows were confirmed under one alias that contains both flavours. The
  // variant rule ruled each out by the other's word, the result was null, and
  // the code read null.name: the throw was caught and memory gave nothing.
  const alias = ["chocolate vanilla whey"];
  const rows = [
    { ...food("chocolate whey", 390), confirmed_aliases: alias, times: 3 },
    { ...food("vanilla whey", 380), confirmed_aliases: alias, times: 1 },
  ];
  const down = { apiKey: "jev", timeoutMs: 1000, fetchFn: (async () => new Response("down", { status: 503 })) as typeof fetch };
  const m = await matchMemory(down, rows, { name: "chocolate vanilla whey", brand: null });
  assertEquals(m.trace.path, "confirmed_alias");
  assertEquals(m.food?.name, "chocolate whey");
});

// ── A maybe band, and brand spelling (owner decision 2026-10-31) ───────────
// Live, 2026-10-18..28: one user's saved Too Yumm label scored 0.51-0.72 every
// time she typed "too yum protein oats", so it never served and the line was a
// guess (or, once, another company's oats). 0.7 serves; 0.6-0.7 goes to decide
// to judge; and Jev is asked with the brand spelled as her saved food spells it.

/** A Jev that answers every question with this "same" chance, and records what it was asked. */
const jevSame = (same: number, asked: unknown[] = []) => ({
  apiKey: "k",
  timeoutMs: 1000,
  fetchFn: (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    asked.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, {
      type: "score", probabilities: { "0": 1 - same - 0.01, "1": 0.01, "2": same },
    }]));
    return new Response(JSON.stringify({ model: "test", answers, usage: {} }), { status: 200 });
  }) as unknown as typeof fetch,
});

const label = () => food("Too Yumm! High Protein Super Oats - Masala", 365);

Deno.test("0.7 serves a saved food; 0.6-0.7 is a maybe for decide; under 0.6 is neither", async () => {
  const at = async (same: number) => await matchMemory(jevSame(same), [label()], { name: "too yum protein oats", brand: "Too Yum" });
  const served = await at(0.72);
  assertEquals([served.food?.name, served.maybe ?? null], [label().name, null]);
  const maybe = await at(0.65);
  assertEquals([maybe.food, maybe.maybe?.name, maybe.confidence], [null, label().name, 0.65]);
  const none = await at(0.55);
  assertEquals([none.food, none.maybe ?? null], [null, null]);
});

Deno.test("Jev is asked with the brand spelled as her saved food spells it", async () => {
  const asked: Array<{ state: { foods: Array<{ name: string; brand: string | null }> }; questions: Record<string, { instructions: string }> }> = [];
  await matchMemory(jevSame(0.8, asked), [label()], { name: "too yum protein oats", brand: "Too Yum" });
  assertEquals(asked[0].state.foods[0], { id: "f1", name: "Too Yumm protein oats", brand: "Too Yumm" } as never);
  assert(asked[0].questions.m1.instructions.includes("Input food: Too Yumm protein oats."));
});

Deno.test("brand spelling: fixed from the saved name, with or without a brand field", () => {
  const foods = [label(), food("Pintola protein oats", 393)];
  assertEquals(respellForJev({ name: "too yum protein oats", brand: "Too Yum" }, foods), { name: "Too Yumm protein oats", brand: "Too Yumm" });
  assertEquals(respellForJev({ name: "too yum protein oats", brand: null }, foods), { name: "Too Yumm protein oats", brand: null });
  // Brand field set, name without it: only the field changes.
  assertEquals(respellForJev({ name: "protein masala oats", brand: "Too Yum" }, foods), { name: "protein masala oats", brand: "Too Yumm" });
});

Deno.test("brand spelling: left alone when right, when another word, or when unsure", () => {
  // Already spelled as saved.
  assertEquals(respellForJev({ name: "too yumm protein oats", brand: "Too Yumm" }, [label()]), null);
  // Two letters off is another brand: rival snack brands sit exactly there.
  assertEquals(respellForJev({ name: "bikano bhujia", brand: "Bikano" }, [food("Bikaji Bhujia", 560)]), null);
  // Short words are never respelled: "oat" is not a typo of "oats".
  assertEquals(respellForJev({ name: "oat milk", brand: null }, [food("oats", 380)]), null);
  // Two saved foods disagree on the spelling: no guess.
  assertEquals(respellForJev({ name: "pintola oats", brand: "Pintola" }, [food("Pintolo oats", 380), food("Pintala oats", 380)]), null);
});

// ── The maybe band end to end: decide judges it ─────────────────────────────

/** deps() with the decide call recorded, and told to take the saved food or not. */
function maybeDeps(score: number, takeSaved: boolean, seen: { decide?: Record<string, unknown> }, lookups: string[]) {
  const calls: string[] = [];
  const d = deps([live({ tier: "precise" })], { "grilled chicken breast": score }, calls, lookups, EXTRACTED);
  const inner = d.fetchFn!;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const tool = (body.tools ?? [])[0]?.name;
    if (tool === "log_meal") {
      seen.decide = JSON.parse(body.messages[0].content);
      if (!takeSaved) {
        return Response.json({
          stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", name: tool, input: {
            meal_type: "lunch", drona_line: "ok",
            items: [{ food_name: "grilled chicken breast", food_id: null, quantity: 150, serving_label: "g", grams: 150, kcal: 250, protein_g: 45, carb_g: 0, fat_g: 7, confidence: "medium", assumption: "my estimate" }],
          } }],
        });
      }
    }
    return inner(url, init);
  }) as typeof fetch;
  return { ...d, fetchFn, jev: { ...d.jev!, fetchFn } };
}

type DecideItem = { saved_food_check?: { food_id: string; name: string; jev_same: number }; candidates: Array<{ food_id: string }> };

Deno.test("Thorough: a saved food at 0.65 goes to decide, which takes it", async () => {
  const seen: { decide?: Record<string, unknown> } = {}, lookups: string[] = [];
  const r = await runParseMeal(maybeDeps(0.65, true, seen, lookups), { ...BASE, text: "150g grilled chicken breast", mode: null });
  const asked = (seen.decide!.items as DecideItem[])[0];
  // The normal lookup still ran, so decide has the catalog beside it.
  assert(lookups.some((l) => l.startsWith("search:")), JSON.stringify(lookups));
  assertEquals(asked.saved_food_check?.name, "grilled chicken breast");
  assertEquals(asked.saved_food_check?.jev_same, 0.65);
  // Not among the candidates: it is a question, not a row to pick by rank.
  assert(!asked.candidates.some((c) => c.food_id === asked.saved_food_check?.food_id));
  const item = r.parsed!.items[0];
  assertEquals(item.assumption, memoryNote({ ...food("x", 1), last_logged_at: liveAgo(1) }, "Asia/Kolkata"));
  // Her words ride along, so keeping the line teaches them as a name for it.
  assertEquals(item.memory_input_name, "grilled chicken breast");
  // Her own numbers: 226 kcal for the 150 g she logged.
  assertEquals([item.confidence, item.food_id, item.kcal], ["high", null, 226]);
});

Deno.test("Thorough: decide says different, and the saved food is not used", async () => {
  const seen: { decide?: Record<string, unknown> } = {}, lookups: string[] = [];
  const r = await runParseMeal(maybeDeps(0.65, false, seen, lookups), { ...BASE, text: "150g grilled chicken breast", mode: null });
  assert((seen.decide!.items as DecideItem[])[0].saved_food_check);
  const item = r.parsed!.items[0];
  assertEquals(item.memory_input_name, undefined);
  assertEquals(item.assumption, "my estimate");
});

Deno.test("under 0.6 decide is not asked about the saved food", async () => {
  const seen: { decide?: Record<string, unknown> } = {}, lookups: string[] = [];
  await runParseMeal(maybeDeps(0.55, true, seen, lookups), { ...BASE, text: "150g grilled chicken breast", mode: null });
  assertEquals((seen.decide!.items as DecideItem[])[0].saved_food_check, undefined);
});

Deno.test("Quick has no decide call: a 0.65 saved food is not used", async () => {
  const seen: { decide?: Record<string, unknown> } = {}, lookups: string[] = [];
  const d = maybeDeps(0.65, true, seen, lookups);
  const r = await runParseMeal(
    { ...d, fetchFn: net({ scores: { "grilled chicken breast": 0.65 }, calls: [], line: ESTIMATED }), jev: { ...d.jev!, fetchFn: net({ scores: { "grilled chicken breast": 0.65 }, calls: [], line: ESTIMATED }) } },
    { ...BASE, text: "150g grilled chicken breast", mode: "fast" },
  );
  assertEquals(r.parsed!.items[0].source, "estimate");
  assertEquals(seen.decide, undefined);
});

// ── A saved food's brand, set apart for Jev (owner decision 2026-10-31) ──────
// Saved as "Kesar pista oats yogabar", her food scored 0.11 for "kesar pista
// oats": Jev read "oats ... yoga bar" as a snack bar. With the brand known and
// shown apart, "Kesar pista oats (Yogabar)", it scored 0.94-0.99, and the eval
// went from 52 to 56 of 60 served with no wrong food (memory-identity-eval,
// CAND_BRAND=brackets).

Deno.test("the brand comes out of the name and goes in brackets", () => {
  assertEquals(brandApart("Kesar pista oats yogabar", "Yogabar"), "Kesar pista oats (Yogabar)");
  // Spaced or joined, it is the same brand.
  assertEquals(brandApart("Kesar pista oats yogabar", "Yoga Bar"), "Kesar pista oats (Yoga Bar)");
  assertEquals(brandApart("Too Yumm! High Protein Super Oats - Masala", "Too Yumm"), "High Protein Super Oats - Masala (Too Yumm)");
  // A brand the name does not carry is added; no brand changes nothing.
  assertEquals(brandApart("Toned milk", "Amul"), "Toned milk (Amul)");
  assertEquals(brandApart("casein", null), "casein");
  // A name that is only the brand keeps its name.
  assertEquals(brandApart("Yogabar", "Yogabar"), "Yogabar");
});

Deno.test("Jev sees a saved food with its brand apart", () => {
  const q = memoryQuestions({ name: "kesar pista oats", brand: null }, [{ ...food("Kesar pista oats yogabar", 340), brand: "Yogabar" }]);
  const text = String(q.m1.instructions);
  assert(text.endsWith("Candidate previously logged by this user: Kesar pista oats (Yogabar)."), text);
});

Deno.test("a saved food keeps the brand its rows carry", () => {
  const foods = buildMemory([
    { ...entry({ food_name: "Kesar pista oats yogabar", logged_at: daysAgo(3) }), brand: null },
    { ...entry({ food_name: "Kesar pista oats yogabar", logged_at: daysAgo(1) }), brand: "Yogabar", persistent: true },
  ], "precise", NOW);
  assertEquals(foods[0].brand, "Yogabar");
});

Deno.test("a logged line carries its brand, so saving it can store it", async () => {
  const calls: string[] = [], lookups: string[] = [];
  // Memory answers (a saved food with a brand; Jev is asked about it by its
  // name with the brand apart)...
  const r = await runParseMeal(
    deps([live({ tier: "precise" }), { ...live({ tier: "precise" }), brand: "Brand A", persistent: true }], { "grilled chicken breast (Brand A)": 0.97 }, calls, lookups, EXTRACTED),
    { ...BASE, text: "150g grilled chicken breast", mode: null },
  );
  assert(r.tool_calls.includes("user_memory_match"), JSON.stringify(r.tool_calls));
  assertEquals(r.parsed!.items[0].brand, "Brand A");
  // ...and Quick's own estimate keeps the brand extract read.
  const q = await runParseMeal(
    deps([], {}, [], [], { ...ESTIMATED, brand: "Brand B" }),
    { ...BASE, text: "150g brand b grilled chicken breast", mode: "fast" },
  );
  assertEquals(q.parsed!.items[0].brand, "Brand B");
});

Deno.test("brand spelling: a one-word food is never respelled toward a saved name", () => {
  // "mango" is one letter from "Mange", and is another food.
  assertEquals(respellForJev({ name: "mango shake", brand: null }, [food("Mange tout", 40)]), null);
  // A typo of her saved brand still is, when the saved food knows its brand.
  assertEquals(
    respellForJev({ name: "pintolla oats", brand: null }, [{ ...food("Chocolate protein oats", 390), brand: "Pintola" }]),
    { name: "Pintola oats", brand: null },
  );
  // And a two-word brand slip with no brand known yet, as on 10-18.
  assertEquals(respellForJev({ name: "too yum protein oats", brand: null }, [label()]), { name: "Too Yumm protein oats", brand: null });
});

// ── A choice question when no saved food scored (owner decision 2026-10-31) ─
// The score asks about each saved food alone. When none reaches the maybe
// floor, one choice question asks which saved food it is, or none. Its top
// answer goes to decide only when it is a food, not "none", with 0.3 or more.
// Eval: "masala tea" -> her "Masala chai" (86%) now reaches decide; "peanut
// chikki" (none 49%, peanuts 47%) does not.

/** A Jev that scores every saved food at `score`, and answers the choice question with `choice`. */
const jevScoreThenChoice = (score: number, choice: Record<string, number>, asked: string[] = []) => ({
  apiKey: "k",
  timeoutMs: 1000,
  fetchFn: (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(body.questions as Record<string, { type: string; criteria: Record<string, string> | string[] }>)) {
      asked.push(q.type);
      if (q.type === "choice") {
        // Map names to the question's own keys.
        const probs: Record<string, number> = {};
        for (const [key, name] of Object.entries(q.criteria as Record<string, string>)) {
          probs[key] = key === "none" ? choice.none ?? 0 : choice[name] ?? 0;
        }
        const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
        answers[k] = { type: "choice", choice: top[0], confidence: top[1], probabilities: probs };
      } else {
        answers[k] = { type: "score", probabilities: { "0": 1 - score - 0.01, "1": 0.01, "2": score } };
      }
    }
    return new Response(JSON.stringify({ model: "test", answers, usage: {} }), { status: 200 });
  }) as unknown as typeof fetch,
});

Deno.test("no saved food scored: the choice's top food goes to decide", async () => {
  const asked: string[] = [];
  const chai = food("Masala chai", 45), powder = food("Tea masala powder", 300);
  const m = await matchMemory(jevScoreThenChoice(0.4, { "Masala chai": 0.86, none: 0.13, "Tea masala powder": 0.01 }, asked), [chai, powder], { name: "masala tea", brand: null });
  assertEquals([m.food, m.maybe?.name, m.confidence], [null, "Masala chai", 0.86]);
  assert(asked.includes("choice"));
  assertEquals((m.trace.choice as { pick: string }).pick, "Masala chai");
});

Deno.test("the choice says none ahead of a food: nothing goes to decide", async () => {
  // Live eval, 2026-10-31: "peanut chikki" -> none 49%, peanuts 47%.
  const m = await matchMemory(jevScoreThenChoice(0.4, { peanuts: 0.47, none: 0.49, "Pintola peanut butter": 0.04 }), [food("peanuts", 580), food("Pintola peanut butter", 590)], { name: "peanut chikki", brand: null });
  assertEquals([m.food, m.maybe ?? null], [null, null]);
});

Deno.test("the choice's top food under 0.3 does not go to decide", async () => {
  const m = await matchMemory(jevScoreThenChoice(0.4, { "grilled chicken breast": 0.25, "raw chicken breast": 0.24, none: 0.2 }), [food("grilled chicken breast", 165), food("raw chicken breast", 120)], { name: "chicken curry", brand: null });
  assertEquals([m.food, m.maybe ?? null], [null, null]);
});

Deno.test("a score in the maybe band needs no choice question", async () => {
  const asked: string[] = [];
  const m = await matchMemory(jevScoreThenChoice(0.65, { none: 1 }, asked), [label()], { name: "too yum protein oats", brand: "Too Yum" });
  assertEquals(m.maybe?.name, label().name);
  assert(!asked.includes("choice"));
});

Deno.test("the choice question shows each saved food with its brand apart", () => {
  const q = memoryChoiceQuestion({ name: "kesar pista oats", brand: null }, [{ ...food("Kesar pista oats yogabar", 340), brand: "Yogabar" }, food("rolled oats", 380)]);
  assertEquals(q.type, "choice");
  assertEquals((q as { criteria: Record<string, string> }).criteria, { m1: "Kesar pista oats (Yogabar)", m2: "rolled oats", none: MEMORY_CHOICE_NONE });
  assert(String(q.instructions).endsWith("Input food: kesar pista oats."));
});

Deno.test("Quick asks no choice question: it has no decide step to use one", async () => {
  // In Quick the choice answer cannot be used, so the call would be wasted.
  const asked: string[] = [];
  const net = jevScoreThenChoice(0.4, { "Masala chai": 0.86, none: 0.14 }, asked);
  const m = await matchMemory(net, [food("Masala chai", 45)], { name: "masala tea", brand: null }, { choice: false });
  assertEquals([m.food, m.maybe ?? null], [null, null]);
  assert(!asked.includes("choice"), JSON.stringify(asked));
});

Deno.test("a Quick log sends no choice question; a Thorough one does", async () => {
  const typesFor = async (mode: "fast" | null) => {
    const types: string[] = [];
    const d = deps([live({ tier: "precise" })], { "grilled chicken breast": 0.4 }, [], [], mode === "fast" ? ESTIMATED : EXTRACTED);
    const inner = d.fetchFn!;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("typesafe.ai")) {
        for (const q of Object.values(JSON.parse(String(init?.body)).questions as Record<string, { type: string }>)) types.push(q.type);
      }
      return inner(url, init);
    }) as typeof fetch;
    await runParseMeal({ ...d, fetchFn, jev: { ...d.jev!, fetchFn } }, { ...BASE, text: "150g grilled chicken breast", mode });
    return types;
  };
  assert(!(await typesFor("fast")).includes("choice"));
  assert((await typesFor(null)).includes("choice"));
});

Deno.test("no saved food scored 0.3: no choice question at all", async () => {
  // The choice cost a second Jev call on most new foods. In the
  // eval it only ever helped where a saved food had scored (masala tea: 0.91,
  // then blocked by the word veto); with every score under 0.15 it found
  // nothing right and once sent peanuts for "peanut chikki".
  const asked: string[] = [];
  const m = await matchMemory(jevScoreThenChoice(0.13, { peanuts: 0.49, none: 0.47 }, asked), [food("peanuts", 580)], { name: "peanut chikki", brand: null });
  assertEquals(m.maybe ?? null, null);
  assert(!asked.includes("choice"), JSON.stringify(asked));
  assertEquals((m.trace.choice as { skipped: string }).skipped, "low_scores");
});

Deno.test("brand spelling: a two-word spelling variant is respelled to her saved one", () => {
  // Same food, her spelling: Jev reads it as
  // she saved it. Only Jev's input changes, never the card or the alias.
  assertEquals(respellForJev({ name: "greek yogurt", brand: null }, [food("Greek yoghurt", 60)]), { name: "Greek yoghurt", brand: null });
});

Deno.test("brand spelling: two saved brands one letter apart", () => {
  // Saved brands "Pintola" and "Pintala" are one edit apart.
  const foods = [{ ...food("protein oats", 390), brand: "Pintola" }, { ...food("peanut butter", 600), brand: "Pintala" }];
  // A slip one edit from both: no guess.
  assertEquals(respellForJev({ name: "oats", brand: "Pintula" }, foods), null);
  // Typed exactly as one of them: nothing to change.
  assertEquals(respellForJev({ name: "oats", brand: "Pintala" }, foods), null);
  // One edit from one, two from the other: that one.
  assertEquals(respellForJev({ name: "oats", brand: "Pintolla" }, foods), { name: "oats", brand: "Pintola" });
});

Deno.test("the choice question carries the rule, not the score's own framing", () => {
  // It is built by cutting the score's first and last sentences out of
  // MEMORY_RULE. If that wording changes and a cut misses, the choice would
  // ask Jev to "score the candidate": this fails instead.
  const text = String(memoryChoiceQuestion({ name: "oats", brand: null }, [food("rolled oats", 380)]).instructions);
  assert(text.startsWith("Which of these foods, each one this user logged before, is the food the user's words describe? "), text);
  assert(!/Score the candidate|Judge one thing/.test(text), text);
  // The body of the rule is still there.
  assert(text.includes("Judge intended identity, not exact wording."), text);
});
