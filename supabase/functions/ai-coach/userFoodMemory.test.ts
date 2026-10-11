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
  // With no sibling over the floor, 0.73 still serves nothing.
  assertEquals(decideMemory([list[0]], [0.73]).food, null);
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
