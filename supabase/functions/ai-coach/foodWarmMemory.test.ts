// Run with: deno test --allow-all supabase/functions/ai-coach/foodWarmMemory.test.ts
//
// Warm memory for the Precise food agent (FOOD_WARM_MEMORY, foodWarmMemory.ts).
// What these pin:
//   - off changes nothing: the opening message, the instructions and the
//     tools are exactly today's when the agent has no warm deps
//   - recall_food: the user's own foods by name, facts only, read only, memory
//     loaded once per message, at most 3 calls, a refusal for no name
//   - memory matches: only what Jev already decided in this message's parse
//     (from its steps), tied to its line; in parse_food results, and in a
//     first-message opening only when that parse had already finished
//   - the thread: its first message once it left the recent turns, its
//     read_thread and search_threads (caps, refusals, one user only)
//   - the thread's turns come from memory first: the app's recent turns and
//     the request's own load; the database only for what is missing
//   - build_recipe takes a remembered dish's amounts for parts sent with none

import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  CARD_NOTE_LATER,
  type FoodAgentDeps,
  FOOD_AGENT_SYSTEM_LATER,
  openingText,
  recentDays,
  runFoodAgent,
  toolsForLater,
} from "./foodAgent.ts";
import type { CardLine } from "./foodContext.ts";
import type { ParsedItem, ParseMealResult, ParseStep } from "./parseMeal.ts";
import { BUILD_RECIPE_TOOL, RECIPE_NOTE, rememberedPart } from "./recipe.ts";
import { matchMemory, type MemoryEntry } from "./userFoodMemory.ts";
import { memoryThreadStore, supabaseThreadStore, threadForAgent, type ThreadHit, type ThreadTurn } from "./foodThreads.ts";
import {
  type FoodAgentWarm,
  MAX_RECALL_PER_RUN,
  memoryMatchesBlock,
  memoryMatchesOf,
  memoryFacts,
  parseFoodWarmMemoryMode,
  recallAnswer,
  type RecallFood,
  recallFoods,
  RECIPE_MEMORY_NOTE,
  firstMessageSafe,
  hasOlderTurns,
  threadTurnsMemory,
  warmThreadText,
  warmThreadFrom,
} from "./foodWarmMemory.ts";

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
const NOW = new Date("2026-11-08T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

type Use = { name: string; input: Record<string, unknown> };
function scripted(script: Use[][], bodies: Record<string, unknown>[] = []): FoodAgentDeps["callModel"] {
  let n = 0;
  return async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const uses = script[Math.min(n, script.length - 1)];
    n++;
    return { ok: true, data: { usage: { input_tokens: 1, output_tokens: 1 }, content: uses.map((u, i) => ({ type: "tool_use", id: `t${n}_${i}`, name: u.name, input: u.input })) } };
  };
}

function entry(name: string, grams: number, kcal: number, at: string, more: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    food_name: name, food_id: null, kcal, protein_g: 5, carb_g: 30, fat_g: 2, fiber_g: null, grams, quantity: grams,
    serving_unit: "g", source: "catalog", logged_via: "ai", tier: "precise", logged_at: at, ...more,
  };
}

// Jeera rice 171 kcal per 100 g, usually 100 g (logged 3 times, once at 150 g).
const ENTRIES: MemoryEntry[] = [
  entry("Jeera rice", 100, 171, daysAgo(1)),
  entry("Jeera rice", 100, 171, daysAgo(3)),
  entry("Jeera rice", 150, 256.5, daysAgo(5)),
  entry("Masala oats", 40, 150, daysAgo(2)),
  // A saved cache row (per 100 g, no amount of its own) with a brand.
  {
    ...entry("Milky Mist low fat paneer", 100, 254, daysAgo(4)),
    persistent: true, confirmed_at: daysAgo(4), brand: "Milky Mist",
  },
];

function foods(): RecallFood[] {
  return recallFoods(ENTRIES, "precise", false, NOW);
}

const CARD: CardLine[] = [
  { food_name: "Jeera rice", quantity: 100, serving_label: "g", grams: 100, kcal: 171, protein_g: 4, carb_g: 30, fat_g: 3, source: "catalog", meal_type: "lunch" },
  { food_name: "Dal", quantity: 1, serving_label: "katori", grams: 150, kcal: 150, protein_g: 7, carb_g: 20, fat_g: 4, source: "catalog", meal_type: "lunch" },
];

const base = (bodies: Record<string, unknown>[], script: Use[][], more: Partial<FoodAgentDeps> = {}): FoodAgentDeps => ({
  model: "m",
  callModel: scripted(script, bodies),
  readDiary: async () => ({}),
  savedMeals: async () => [],
  parseFood: async () => ({ parsed: null, declined: { message: "no food" }, usage: USAGE, tool_calls: [], steps: [], iterations: 1 }) as ParseMealResult,
  ...more,
});

const toolNames = (b: Record<string, unknown>) => (b.tools as { name: string }[]).map((t) => t.name);
const firstUser = (b: Record<string, unknown>) => {
  const m = (b.messages as { role: string; content: unknown }[]).filter((x) => x.role === "user").at(-1)!;
  return String(m.content);
};

// ── The switch ─────────────────────────────────────────────────────────────

Deno.test("parseFoodWarmMemoryMode: anything but on is off", () => {
  assertEquals(parseFoodWarmMemoryMode("on"), "on");
  assertEquals(parseFoodWarmMemoryMode(" ON "), "on");
  assertEquals(parseFoodWarmMemoryMode("shadow"), "off");
  assertEquals(parseFoodWarmMemoryMode(undefined), "off");
});

Deno.test("off: the opening message, instructions and tools are today's, byte for byte", async () => {
  const bodies: Record<string, unknown>[] = [];
  const input = { text: "make the rice 150 g", defaultMeal: "lunch" as const, later: true, card: CARD, today: "Sunday 2026-11-08",
    warmThread: { first: "lunch was jeera rice and dal", turns: 14 } };
  await runFoodAgent(input, base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { buildRecipe: true }));
  const b = bodies[0];
  // The opening message is the two-argument openingText, which is today's.
  assertEquals(firstUser(b), openingText(input, recentDays(input.today)));
  assertEquals(b.system, [FOOD_AGENT_SYSTEM_LATER, CARD_NOTE_LATER, RECIPE_NOTE].join("\n"));
  assertEquals(toolNames(b), [...toolsForLater(CARD).map((t) => t.name), BUILD_RECIPE_TOOL.name]);
  // A warmThread without warm deps (the switch off) puts nothing in.
  assertFalse(JSON.stringify(b).includes("First message of this thread"));
  for (const n of ["recall_food", "read_thread", "search_threads"]) assertFalse(JSON.stringify(b).includes(n), n);
});

Deno.test("off: a model that names recall_food anyway gets no read (the run ends as an unknown tool)", async () => {
  const out = await runFoodAgent(
    { text: "rice", defaultMeal: "lunch", later: true, card: CARD },
    base([], [[{ name: "recall_food", input: { name: "rice" } }]]),
  );
  assertEquals(out.kind, "failed");
  if (out.kind === "failed") assertEquals(out.reason, "unknown_tool_recall_food");
});

Deno.test("not a later-mode run: warm deps are ignored", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "jeera rice", defaultMeal: "lunch" },
    base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { warm: { memory: async () => foods() } }),
  );
  assertFalse(toolNames(bodies[0]).includes("recall_food"));
  assertFalse(firstUser(bodies[0]).includes("name match"));
});

// ── The user's foods ───────────────────────────────────────────────────────

Deno.test("recallFoods: usual amount, times in the window, brand, from the parse's own memory", () => {
  const f = foods();
  const rice = f.find((x) => x.name === "Jeera rice")!;
  assertEquals(rice.per100.kcal, 171);
  assertEquals(rice.usual?.grams, 100); // twice at 100 g, once at 150 g
  assertEquals(rice.times, 3);
  const paneer = f.find((x) => x.name === "Milky Mist low fat paneer")!;
  assertEquals(paneer.brand, "Milky Mist");
  assertEquals(paneer.usual, null); // a saved row has no amount of its own
  assertEquals(paneer.times, 0);
});

// ── recall_food ────────────────────────────────────────────────────────────

Deno.test("recallAnswer: up to 3 name matches, facts only, no bare kcal beside a name", () => {
  const a = recallAnswer(foods(), "jeera rice") as { foods: Record<string, unknown>[] };
  assertEquals(a.foods[0].name, "Jeera rice");
  assertEquals((a.foods[0].per_100g as { kcal: number }).kcal, 171);
  assertEquals((a.foods[0].usual_amount as { grams: number }).grams, 100);
  assertEquals(a.foods[0].logged_last_10_days, 3);
  assertEquals(a.foods[0].numbers_from, "catalog");
  assertFalse("kcal" in a.foods[0]);
  // A word the name holds is enough: "paneer" finds the paneer.
  const p = recallAnswer(foods(), "paneer") as { foods: Record<string, unknown>[] };
  assertEquals(p.foods.map((x) => x.name), ["Milky Mist low fat paneer"]);
  assertEquals(p.foods[0].brand, "Milky Mist");
  // Nothing close: an empty list, said plainly.
  const none = recallAnswer(foods(), "sushi") as { foods: unknown[]; note: string };
  assertEquals(none.foods, []);
});

Deno.test("recallAnswer: a dish's parts come back", () => {
  const dish: RecallFood[] = recallFoods([
    entry("Paneer sabji", 110, 260, daysAgo(1), { recipe: [{ name: "low fat paneer", grams: 60 }, { name: "oil", grams: 10, assumed: true }, { name: "onion", grams: 40 }] }),
  ], "precise", false, NOW);
  const a = recallAnswer(dish, "paneer sabji") as { foods: { parts: unknown[] }[] };
  assertEquals(a.foods[0].parts, [
    { part: "low fat paneer", grams: 60 },
    { part: "oil", grams: 10, amount_was_assumed: true },
    { part: "onion", grams: 40 },
  ]);
});

Deno.test("agent: recall_food reads memory once, changes nothing, and is capped at 3 calls", async () => {
  let loads = 0;
  const bodies: Record<string, unknown>[] = [];
  const events: unknown[] = [];
  const warm: FoodAgentWarm = { memory: () => { loads++; return Promise.resolve(foods()); } };
  // The caller memoizes; the agent must still call memory() for each use.
  let memo: Promise<RecallFood[]> | null = null;
  const once: FoodAgentWarm = { memory: () => (memo ??= warm.memory!()) };
  const r = (name: string) => ({ name: "recall_food", input: { name } });
  const out = await runFoodAgent(
    { text: "what do I usually have with rice", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [
      [r("jeera rice"), r("dal")],
      [r("oats"), r("paneer")],
      [{ name: "reply", input: { text: "You usually have 100 g." } }],
    ], { warm: once, onEvent: (e) => events.push(e) }),
  );
  assertEquals(loads, 1);
  assertEquals(out.kind, "reply");
  // Read only: no card change happened.
  assertFalse(events.some((e) => (e as { tool: string }).tool === "card_changes"));
  // Offered, and its results went back: the 4th call is refused by the cap.
  assert(toolNames(bodies[0]).includes("recall_food"));
  const results = JSON.stringify(bodies[2].messages);
  assertStringIncludes(results, `recall_food was already called ${MAX_RECALL_PER_RUN} times for this message`);
  assertStringIncludes(results, "Jeera rice");
});

Deno.test("agent: recall_food with no name is refused, and the run goes on", async () => {
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "x", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [[{ name: "recall_food", input: { name: " " } }], [{ name: "reply", input: { text: "ok" } }]], { warm: { memory: async () => foods() } }),
  );
  assertEquals(out.kind, "reply");
  assertStringIncludes(JSON.stringify(bodies[1].messages), "recall_food needs a food name.");
});

const EDITED_RICE: ParseMealResult = {
  parsed: { meal_type: "lunch", items: [line("Jeera rice", 85.5, { grams: 50, quantity: 50, serving_label: "g" })], drona_line: "", corrects_previous: true },
  declined: null, usage: USAGE, tool_calls: [], steps: [], iterations: 1, tier: "precise",
};

for (const read of [
  { name: "recall_food", input: { name: "jeera rice" } },
  { name: "read_thread", input: { from_seq: 1 } },
  { name: "search_threads", input: { query: "jeera rice" } },
]) {
  Deno.test(`agent: ${read.name} in the same turn as edit_line never holds it: the edit lands in that turn`, async () => {
    const bodies: Record<string, unknown>[] = [];
    let edits = 0;
    const out = await runFoodAgent(
      { text: "the rice was 50 g", defaultMeal: "lunch", later: true, card: CARD, recentTurns: appCopy(5, 14), warmThread: { first: null, turns: 14 } },
      base(bodies, [
        [read, { name: "edit_line", input: { line_id: "L1", change: "50 g" } }],
        [{ name: "reply", input: { text: "should not be reached" } }],
      ], {
        warm: { memory: async () => foods(), readThread: async () => [], searchThreads: async () => [] },
        editLine: async () => { edits++; return EDITED_RICE; },
      }),
    );
    assertEquals(edits, 1);
    assertEquals(bodies.length, 1); // one model call: no held turn
    assertEquals(out.kind, "log");
    if (out.kind === "log") assertEquals(out.result.parsed!.items.map((i) => [i.food_name, i.grams]), [["Jeera rice", 50], ["Dal", 150]]);
  });
}

Deno.test("agent: a read that does hold today (find_label) still holds a same-turn edit beside a warm read", async () => {
  const bodies: Record<string, unknown>[] = [];
  let edits = 0;
  await runFoodAgent(
    { text: "check the rice label, it was 50 g", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [
      [{ name: "find_label", input: { line_id: "L1" } }, { name: "recall_food", input: { name: "jeera rice" } }, { name: "edit_line", input: { line_id: "L1", change: "50 g" } }],
      [{ name: "reply", input: { text: "ok" } }],
    ], { warm: { memory: async () => foods() }, findLabel: async () => null, editLine: async () => { edits++; return EDITED_RICE; } }),
  );
  assertEquals(edits, 0);
  assertStringIncludes(JSON.stringify(bodies[1].messages), "Not applied yet: this turn also reads data.");
});

// ── Memory matches Jev already decided ────────────────────────────────────

/** A parse's user_memory step as matchMemory's Jev path writes it. */
function jevStep(item: string, rows: [string, number][], match: string | null, conf: number): ParseStep {
  return {
    iter: 1, tool: "user_memory", input: { tier: "precise" },
    result: {
      item, lookup_name: item, remembered: rows.length, policy: "identity-v2", path: "jev", shortlist: rows.length,
      rows: rows.map(([name, score]) => ({ name, kcal: 100, level: "precise", score, different: 0, unclear: 0, same: score })),
      decision: match ? { match, kcal: 100, level: "precise", logged: "2026-11-07", conf } : { match: null, reason: "below_floor", conf },
    },
  };
}

function parsed(items: ParsedItem[], steps: ParseStep[]): ParseMealResult {
  return { parsed: { meal_type: "lunch", items, drona_line: "", corrects_previous: false }, declined: null, usage: USAGE, tool_calls: [], steps, iterations: 1, tier: "precise" };
}

function line(food_name: string, kcal: number, more: Partial<ParsedItem> = {}): ParsedItem {
  return { food_id: null, food_name, quantity: 1, serving_label: "serving", grams: 100, kcal, protein_g: 5, carb_g: 10, fat_g: 2, fiber_g: null, source: "catalog", assumption: null, confidence: "medium", ...more };
}

Deno.test("memoryFacts: the chosen food and the near ones (VARIANT_FLOOR up to MEMORY_FLOOR), from the parse's own steps", () => {
  const f = memoryFacts([
    jevStep("jeera rice", [["Jeera Rice", 0.92], ["Jeera rice (homemade)", 0.64], ["Rice", 0.3]], "Jeera Rice", 0.92),
    jevStep("paneer sabji", [["Milky Mist low fat paneer sabji", 0.7], ["Paneer tikka", 0.2]], null, 0.7),
    jevStep("chai", [["Masala chai", 0.4]], null, 0.4),
    { iter: 1, tool: "user_memory", input: { tier: "precise" }, result: { skipped: "existing_card" } },
  ]);
  assertEquals(f, [
    { words: "jeera rice", path: "jev", chosen: { name: "Jeera Rice", score: 0.92 }, near: [{ name: "Jeera rice (homemade)", score: 0.64 }] },
    { words: "paneer sabji", path: "jev", chosen: null, near: [{ name: "Milky Mist low fat paneer sabji", score: 0.7 }] },
  ]);
});

Deno.test("memoryFacts: a confirmed alias, as matchMemory's real trace has it (no Jev call)", async () => {
  const food = { key: "jeera rice", name: "Jeera Rice", food_id: null, per100: { kcal: 171, protein_g: 4, carb_g: 30, fat_g: 3, fiber_g: null },
    serving: null, source: "catalog", level: "precise" as const, times: 3, last_logged_at: daysAgo(1), confirmed_aliases: ["jeera rice"] };
  let calls = 0;
  const m = await matchMemory({ apiKey: "k", timeoutMs: 100, fetchFn: (async () => { calls++; return new Response("x", { status: 500 }); }) as typeof fetch }, [food], { name: "jeera rice", brand: null });
  assertEquals(calls, 0);
  const f = memoryFacts([{ iter: 1, tool: "user_memory", input: { tier: "precise" }, result: m.trace }]);
  assertEquals(f, [{ words: "jeera rice", path: "confirmed_alias", chosen: { name: "Jeera Rice", score: 1 }, near: [] }]);
});

Deno.test("memoryMatchesOf: each decision tied to the line it was for, no kcal beside a name", () => {
  const r = parsed([line("Jeera Rice", 171), line("Paneer sabji", 200, { said_name: "paneer sabji" })], [
    jevStep("jeera rice", [["Jeera Rice", 0.92]], "Jeera Rice", 0.92),
    jevStep("paneer sabji", [["Milky Mist low fat paneer sabji", 0.7]], null, 0.7),
  ]);
  const m = memoryMatchesOf(r);
  assertEquals(m, [
    { for_words: "jeera rice", line: "Jeera Rice", chosen: { name: "Jeera Rice", jev_score: 0.92 }, near: [] },
    { for_words: "paneer sabji", line: "Paneer sabji", chosen: null, near: [{ name: "Milky Mist low fat paneer sabji", jev_score: 0.7, chosen: false }] },
  ]);
  assertFalse(JSON.stringify(m).includes("kcal"));
  assertEquals(memoryMatchesOf(parsed([line("Egg", 70)], [])), []);
});

Deno.test("memoryMatchesBlock: one line per decision, facts only; none made means no block", () => {
  const r = parsed([line("Jeera Rice", 171)], [jevStep("jeera rice", [["Jeera Rice", 0.92], ["Jeera rice (homemade)", 0.64]], "Jeera Rice", 0.92)]);
  assertEquals(
    memoryMatchesBlock(r),
    `(Memory matches the app's check (Jev) already made for the food in this message:\n` +
      `- "jeera rice" (parse line "Jeera Rice"): chosen "Jeera Rice", Jev 0.92; near "Jeera rice (homemade)", Jev 0.64, not used.)`,
  );
  assertEquals(memoryMatchesBlock(parsed([line("Egg", 70)], [])), null);
  assertEquals(memoryMatchesBlock(null), null);
});

const RICE_PARSE = parsed([line("Jeera Rice", 171)], [jevStep("jeera rice", [["Jeera Rice", 0.92]], "Jeera Rice", 0.92)]);

Deno.test("agent: a parse_food result carries the memory decisions that parse made", async () => {
  const bodies: Record<string, unknown>[] = [];
  let parses = 0;
  await runFoodAgent(
    { text: "how many calories in my jeera rice", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [[{ name: "parse_food", input: { text: "jeera rice" } }], [{ name: "reply", input: { text: "171 kcal." } }]], {
      parseFood: async () => { parses++; return RICE_PARSE; }, warm: { matches: true },
    }),
  );
  assertEquals(parses, 1); // no second parse, and no Jev call of its own
  const msgs = bodies[1].messages as { content: unknown }[];
  const result = JSON.parse((msgs.at(-1)!.content as { content: string }[])[0].content);
  assertEquals(result.memory_matches, [{ for_words: "jeera rice", line: "Jeera Rice", chosen: { name: "Jeera Rice", jev_score: 0.92 }, near: [] }]);
  assertStringIncludes(String(bodies[0].system), "Memory matches, in a parse_food result or the opening message");
});

Deno.test("agent: a first-message run shows the decisions in its opening message once the parse has finished", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "jeera rice and what should I eat next", defaultMeal: "lunch", later: true, first: true },
    base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { warm: { matches: true, settledFirstParse: () => RICE_PARSE } }),
  );
  assertStringIncludes(firstUser(bodies[0]), `- "jeera rice" (parse line "Jeera Rice"): chosen "Jeera Rice", Jev 0.92.`);
});

Deno.test("agent: a parse still running is never waited for, and no block is shown", async () => {
  const bodies: Record<string, unknown>[] = [];
  let peeks = 0;
  const out = await runFoodAgent(
    { text: "jeera rice", defaultMeal: "lunch", later: true, first: true },
    base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { warm: { matches: true, settledFirstParse: () => { peeks++; return null; } } }),
  );
  assertEquals(out.kind, "reply");
  assertEquals(peeks, 1);
  assertFalse(firstUser(bodies[0]).includes("Memory matches"));
  // A later message beside a card: its card came from an earlier message, so
  // no block (the parse of THIS message has not run).
  const later: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "jeera rice", defaultMeal: "lunch", later: true, card: CARD },
    base(later, [[{ name: "reply", input: { text: "ok" } }]], { warm: { matches: true, settledFirstParse: () => RICE_PARSE } }),
  );
  assertFalse(firstUser(later[0]).includes("Memory matches"));
});

Deno.test("there is no name-only matches block any more", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "the jeera rice was 150 g", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { warm: { memory: async () => foods() } }),
  );
  assertFalse(firstUser(bodies[0]).includes("name match"));
  assertFalse(firstUser(bodies[0]).includes("Memory matches"));
});

// ── The thread ─────────────────────────────────────────────────────────────

Deno.test("warmThreadText: the first message once it left the recent turns, and older turns", () => {
  const w = { first: "lunch was 100g jeera rice and paneer sabji of 60 g paneer", turns: 14 };
  const recent = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "drona" : "user") as "user" | "drona", text: `turn ${i + 5}` }));
  const t = warmThreadText(w, recent, true)!;
  assertStringIncludes(t, `First message of this thread: "lunch was 100g jeera rice and paneer sabji of 60 g paneer"`);
  assertFalse(t.includes("Summary"));
  assertStringIncludes(t, "This thread has 14 earlier turns; the messages above carry the last 10.");
  // Still in the recent turns (cut by the app): not repeated.
  const withFirst = [{ role: "user" as const, text: "lunch was 100g jeera rice" }];
  assertFalse((warmThreadText(w, withFirst, false) ?? "").includes("First message"));
  // Cut to 400 characters.
  const long = warmThreadText({ first: "a".repeat(900), turns: 1 }, [], false)!;
  assert(long.length < 460, String(long.length));
  assertEquals(warmThreadText(null, [], true), null);
});

Deno.test("memoryThreadStore: turnsFrom and searchThreads read one user's threads only", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", "t1");
  await s.addTurns("t1", 1, [{ role: "user", text: "lunch was paneer sabji" }, { role: "drona", text: "On the card." }], "c1");
  await s.addTurns("t1", 3, [{ role: "user", text: "make it 60 g paneer" }], "c2");
  await s.createCard("t1", "card1", "meal", [{ line_id: "L1", name: "Paneer sabji", grams: 120, quantity: 1, unit: "serving", kcal: 210, protein_g: 12, carb_g: 8, fat_g: 14 }], "c1", "lunch");
  await s.ensure("u1", "t2");
  await s.addTurns("t2", 1, [{ role: "user", text: "two eggs" }], "c3");
  await s.ensure("u2", "t3");
  await s.addTurns("t3", 1, [{ role: "user", text: "paneer tikka" }], "c4");
  assertEquals((await s.turnsFrom!("u1", "t1", 2, 10))!.map((t) => t.seq), [2, 3]);
  assertEquals(await s.turnsFrom!("u2", "t1", 1, 10), null);
  const hits = await s.searchThreads!("u1", ["paneer"], { excludeThreadId: "t2", sinceIso: "2000-01-01", limit: 5 });
  assertEquals(hits.map((h) => h.thread_id), ["t1"]); // never u2's t3
  assertEquals(hits[0].first, "lunch was paneer sabji");
  assertEquals(hits[0].lines, ["Paneer sabji, 210 kcal"]);
  // The current thread is left out.
  assertEquals(await s.searchThreads!("u1", ["paneer"], { excludeThreadId: "t1", sinceIso: "2000-01-01", limit: 5 }), []);
});

function threadWarm(turns: ThreadTurn[], hits: ThreadHit[] = []): FoodAgentWarm & { reads: number[]; searches: string[][] } {
  const reads: number[] = [];
  const searches: string[][] = [];
  return {
    reads, searches,
    readThread: async (from, limit) => { reads.push(from); return turns.filter((t) => t.seq >= from).slice(0, limit); },
    searchThreads: async (words) => { searches.push(words); return hits; },
  };
}

Deno.test("agent: read_thread is offered only with older turns, reads them, refuses a bad turn number, is capped", async () => {
  const turns = Array.from({ length: 14 }, (_, i) => ({ seq: i + 1, role: (i % 2 ? "drona" : "user") as "user" | "drona", text: `turn ${i + 1}` }));
  const recent = turns.slice(-10).map((t) => ({ role: t.role, text: t.text }));
  const w = threadWarm(turns);
  const rt = (from: unknown) => ({ name: "read_thread", input: { from_seq: from } });
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "what did I say first", defaultMeal: "lunch", later: true, card: CARD, recentTurns: recent, warmThread: { first: "turn 1", turns: 14 } },
    base(bodies, [[rt(1), rt(0)], [rt(5), rt(9)], [{ name: "reply", input: { text: "You started with turn 1." } }]], { warm: w }),
  );
  assertEquals(out.kind, "reply");
  assert(toolNames(bodies[0]).includes("read_thread"));
  assertStringIncludes(firstUser(bodies[0]), "First message of this thread: \"turn 1\"");
  assertEquals(w.reads, [1, 5]); // the 0 was refused before any read; the 4th call is past the cap
  assertStringIncludes(JSON.stringify(bodies[1].messages), "read_thread needs from_seq, a turn number of 1 or more.");
  assertStringIncludes(JSON.stringify(bodies[2].messages), "read_thread was already called 3 times for this message");
  // No older turns: no read_thread at all.
  const none: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "x", defaultMeal: "lunch", later: true, card: CARD, recentTurns: recent, warmThread: { first: "turn 5", turns: 10 } },
    base(none, [[{ name: "reply", input: { text: "ok" } }]], { warm: threadWarm(turns) }),
  );
  assertFalse(toolNames(none[0]).includes("read_thread"));
});

Deno.test("agent: search_threads finds earlier chats, refuses no words, is capped at 2 calls", async () => {
  const hit: ThreadHit = { thread_id: "t0", date: "2026-11-05", first: "lunch was paneer sabji", lines: ["Paneer sabji, 210 kcal"], score: 1 };
  const w = threadWarm([], [hit]);
  const st = (query: string) => ({ name: "search_threads", input: { query } });
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "same sabji as tuesday", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [[st("paneer sabji"), st("a")], [st("sabji"), st("dal")], [{ name: "reply", input: { text: "ok" } }]], { warm: w }),
  );
  // A refused call counts toward the cap: the third call ("sabji") is past it.
  assertEquals(w.searches, [["paneer", "sabji"]]);
  const r1 = JSON.stringify(bodies[1].messages);
  assertStringIncludes(r1, "Paneer sabji, 210 kcal");
  assertStringIncludes(r1, "search_threads needs food words of 3 letters or more.");
  assertStringIncludes(JSON.stringify(bodies[2].messages), "search_threads was already called 2 times for this message");
});

// ── The thread's turns: memory first, the database only for what is missing ──

/** A memory store holding one thread of `n` turns ("turn 1".."turn n", user
 *  first), and a turnsFrom on it that counts its calls. */
async function storedThread(n: number, text = (i: number) => `turn ${i}`) {
  const store = memoryThreadStore();
  await store.ensure("u1", "t1");
  if (n) await store.addTurns("t1", 1, Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? "drona" : "user") as "user" | "drona", text: text(i + 1) })), "c1");
  const calls: [number, number][] = [];
  const fetch = (from: number, limit: number) => { calls.push([from, limit]); return store.turnsFrom!("u1", "t1", from, limit, { owned: true }); };
  const stored = store.load("u1", "t1", { turns: true }).then((t) =>
    t ? { lastSeq: t.last_seq, lastTurn: t.last_turn ?? null, firstText: t.first_text ?? null } : null
  );
  return { store, calls, fetch, stored };
}

/** The app's copy of turns from..to, as it sends them (role by seq). */
const appCopy = (from: number, to: number, text = (i: number) => `turn ${i}`) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ role: ((from + i) % 2 ? "user" : "drona") as "user" | "drona", text: text(from + i) }));

Deno.test("threadTurnsMemory: the whole thread in the app's turns: first message and read_thread make 0 DB calls", async () => {
  const t = await storedThread(6);
  const mem = threadTurnsMemory({ stored: t.stored, recent: appCopy(1, 6), fetch: t.fetch });
  assertEquals(await warmThreadFrom(mem), { first: "turn 1", turns: 6 });
  assertEquals((await mem.read(2, 10))!.map((x) => x.text), ["turn 2", "turn 3", "turn 4", "turn 5", "turn 6"]);
  assertEquals(t.calls, []);
});

Deno.test("threadTurnsMemory: a long thread: turn 1 comes with the load, read_thread reads only the missing span, once", async () => {
  const t = await storedThread(14);
  const mem = threadTurnsMemory({ stored: t.stored, recent: appCopy(5, 14), fetch: t.fetch });
  assertEquals((await warmThreadFrom(mem))?.first, "turn 1");
  assertEquals(t.calls, []); // turn 1's text rode on the load
  const got = await mem.read(1, 10);
  assertEquals(t.calls, [[2, 3]]); // 1 from the load, 5..10 the app's: only 2..4
  assertEquals(got!.map((x) => [x.seq, x.text]), Array.from({ length: 10 }, (_, i) => [i + 1, `turn ${i + 1}`]));
  await mem.read(1, 10);
  await mem.read(3, 2);
  assertEquals(t.calls.length, 1);
});

Deno.test("threadTurnsMemory: the last write has not landed: nothing is placed, stored text under stored numbers", async () => {
  // Stored 12; the app already holds 14 (its last message's turns not written yet).
  const t = await storedThread(12);
  const mem = threadTurnsMemory({ stored: t.stored, recent: appCopy(5, 14), fetch: t.fetch });
  const got = await mem.read(3, 10);
  assertEquals(got!.map((x) => [x.seq, x.text]), Array.from({ length: 10 }, (_, i) => [i + 3, `turn ${i + 3}`]));
  // Turn 12 was held from the load; 3..11 were read in one call.
  assertEquals(t.calls, [[3, 9]]);
});

Deno.test("threadTurnsMemory: a Drona turn the store never got: the app's turns are not placed", async () => {
  // The store has 11 turns ending with the user's turn 11; the app also has
  // Drona's answer to it, so its turns sit one later than the store's.
  const t = await storedThread(11);
  const recent = [...appCopy(3, 11), { role: "drona" as const, text: "answer never stored" }];
  const mem = threadTurnsMemory({ stored: t.stored, recent, fetch: t.fetch });
  const got = await mem.read(1, 11);
  assertEquals(got!.map((x) => x.text), Array.from({ length: 11 }, (_, i) => `turn ${i + 1}`));
  assertFalse(JSON.stringify(got).includes("never stored"));
  assertEquals(t.calls.length, 1);
});

Deno.test("threadTurnsMemory: a store short of turns (different text at the newest seq) is read, never trusted", async () => {
  const t = await storedThread(14, (i) => `stored ${i}`);
  const mem = threadTurnsMemory({ stored: t.stored, recent: appCopy(5, 14), fetch: t.fetch });
  const got = await mem.read(5, 10);
  assertEquals(got!.map((x) => x.text), Array.from({ length: 10 }, (_, i) => `stored ${i + 5}`));
});

Deno.test("threadTurnsMemory: the app's 400-character cut still matches the stored turn", async () => {
  const long = (i: number) => (i === 14 ? `turn 14 ${"x".repeat(600)}` : `turn ${i}`);
  const t = await storedThread(14, long);
  const recent = appCopy(5, 14, long).map((x) => ({ ...x, text: x.text.slice(0, 400) }));
  const mem = threadTurnsMemory({ stored: t.stored, recent, fetch: t.fetch });
  await mem.read(5, 10);
  assertEquals(t.calls, []);
});

Deno.test("threadTurnsMemory: no open thread means no read at all", async () => {
  const calls: unknown[] = [];
  const mem = threadTurnsMemory({ stored: Promise.resolve(null), recent: appCopy(1, 2), fetch: async () => { calls.push(1); return []; } });
  assertEquals(await warmThreadFrom(mem), null);
  assertEquals(await mem.read(1, 10), null);
  assertEquals(calls, []);
});

Deno.test("agent: read_thread through the turns memory: 0 store calls for turns the app sent, 1 for the missing span", async () => {
  const t = await storedThread(14);
  const recent = appCopy(5, 14);
  const mem = threadTurnsMemory({ stored: t.stored, recent, fetch: t.fetch });
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "what did I say before", defaultMeal: "lunch", later: true, card: CARD, recentTurns: recent, warmThread: { first: null, turns: 14 } },
    base(bodies, [
      [{ name: "read_thread", input: { from_seq: 8 } }],
      [{ name: "read_thread", input: { from_seq: 2 } }],
      [{ name: "reply", input: { text: "ok" } }],
    ], { warm: { readThread: (f, l) => mem.read(f, l) } }),
  );
  assertEquals(t.calls, [[2, 3]]);
  assertStringIncludes(JSON.stringify(bodies[2].messages), "turn 2");
});

Deno.test("firstMessageSafe: only while the thread's first card is on screen and nothing of it was added", () => {
  const c = (id: string, status: string, at: string, kind: "meal" | "save" = "meal") => ({ id, kind, status, created_at: at });
  const open = (cards: ReturnType<typeof c>[]) => ({ status: "open" as const, cards });
  assert(firstMessageSafe(open([c("a", "open", "2026-11-08T10:00:00Z")]), "a"));
  // The first card was added: its food is in the diary already.
  assertFalse(firstMessageSafe(open([c("a", "added", "2026-11-08T10:00:00Z"), c("b", "open", "2026-11-08T10:05:00Z")]), "b"));
  // A later card on screen: the first message was about another card.
  assertFalse(firstMessageSafe(open([c("a", "discarded", "2026-11-08T10:00:00Z"), c("b", "open", "2026-11-08T10:05:00Z")]), "b"));
  // A save card does not count as the meal's card.
  assert(firstMessageSafe(open([c("s", "open", "2026-11-08T09:00:00Z", "save"), c("a", "open", "2026-11-08T10:00:00Z")]), "a"));
  assertFalse(firstMessageSafe({ status: "closed", cards: [c("a", "open", "2026-11-08T10:00:00Z")] }, "a"));
  assertFalse(firstMessageSafe(open([c("a", "open", "2026-11-08T10:00:00Z")]), null));
  assertFalse(firstMessageSafe(null, "a"));
});

Deno.test("warmThreadFrom: with the first message not safe, it is left out and nothing is read for it", async () => {
  const t = await storedThread(14);
  const mem = threadTurnsMemory({ stored: t.stored, recent: appCopy(5, 14), fetch: t.fetch });
  assertEquals(await warmThreadFrom(mem, false), { first: null, turns: 14 });
  assertEquals(t.calls, []);
});

Deno.test("threadForAgent: given the request's load, it does not load the thread again", async () => {
  const store = memoryThreadStore();
  await store.ensure("u1", "t1");
  await store.createCard("t1", "11111111-1111-4111-8111-111111111111", "meal", [{ line_id: "L1", name: "Rice", grams: 100, quantity: 1, unit: "katori", kcal: 130, protein_g: 3, carb_g: 28, fat_g: 0 }], "c1", "lunch");
  let loads = 0;
  const counted = { ...store, load: (u: string, t: string) => { loads++; return store.load(u, t); } };
  const req = { id: "t1", card_id: null, base_version: null, next_card_id: null, closed: null };
  const shared = counted.load("u1", "t1");
  const th = await threadForAgent(counted, "u1", req, Date.now(), shared);
  assert(th?.index);
  assertEquals(loads, 1);
  // Without it (the switch off), the read is its own, as before.
  await threadForAgent(counted, "u1", req);
  assertEquals(loads, 2);
});

// ── build_recipe takes the remembered amounts ──────────────────────────────

const ROWS: Record<string, { kcal: number; protein_g: number; carb_g: number; fat_g: number }> = {
  "low fat paneer": { kcal: 254, protein_g: 25, carb_g: 4, fat_g: 15 },
  "oil": { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 },
  "onion": { kcal: 40, protein_g: 1.1, carb_g: 9.3, fat_g: 0.1 },
};

function fakeParse(log: string[]): (text: string) => Promise<ParseMealResult> {
  return async (text) => {
    log.push(text);
    const m = text.match(/^(\d+(?:\.\d+)?)\s*g\s+(.+)$/);
    const name = (m ? m[2] : text).trim().toLowerCase();
    const grams = m ? Number(m[1]) : 50;
    const row = ROWS[name];
    if (!row) return { parsed: null, declined: { message: "no food" }, usage: USAGE, tool_calls: [], steps: [], iterations: 1 } as ParseMealResult;
    const f = grams / 100;
    const item: ParsedItem = {
      food_id: null, food_name: name, quantity: grams, serving_label: "g", grams,
      kcal: row.kcal * f, protein_g: row.protein_g * f, carb_g: row.carb_g * f, fat_g: row.fat_g * f,
      fiber_g: null, source: "catalog", assumption: null, confidence: "medium",
    };
    return { parsed: { meal_type: "lunch", items: [item], drona_line: "", corrects_previous: false }, declined: null, usage: USAGE, tool_calls: [], steps: [], iterations: 1, tier: "precise" };
  };
}

// Last time: 60 g paneer, 10 g oil (the user answered the question), 40 g onion,
// 30 g tomato.
const SABJI_MEMORY: RecallFood[] = recallFoods([
  entry("Paneer sabji", 140, 300, daysAgo(1), {
    recipe: [{ name: "low fat paneer", grams: 60 }, { name: "oil", grams: 10 }, { name: "onion", grams: 40 }, { name: "tomato", grams: 30 }],
  }),
], "precise", false, NOW);

const SABJI = {
  name: "build_recipe",
  input: { name: "Paneer sabji", parts: [{ name: "low fat paneer", amount: "80 g" }, { name: "oil" }, { name: "onion" }] },
};

Deno.test("agent: build_recipe takes a remembered dish's amounts for parts sent with none, and does not ask again", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "paneer sabji again, 80 g paneer this time", defaultMeal: "lunch", later: true, first: true },
    base(bodies, [[SABJI]], { parseFood: fakeParse(log), buildRecipe: true, warm: { memory: async () => SABJI_MEMORY } }),
  );
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  const dish = out.result.parsed!.items[0];
  // The user's 80 g paneer; the remembered 10 g oil and 40 g onion; the
  // tomato the agent left out is not added.
  assertEquals(log.sort(), ["10 g oil", "40 g onion", "80 g low fat paneer"]);
  assertEquals(dish.recipe?.map((p) => [p.name, p.grams, !!p.assumed]), [["low fat paneer", 80, false], ["oil", 10, false], ["onion", 40, false]]);
  // 80 g paneer 203.2 + 10 g oil 88.4 + 40 g onion 16 = 307.6, summed in code.
  assertEquals(dish.kcal, 307.6);
  assertStringIncludes(dish.assumption!, "From your last log: 10 g oil, 40 g onion.");
  assertFalse(dish.assumption!.includes("Assumed"));
  assertFalse(out.result.parsed!.drona_line.includes("I assumed"), out.result.parsed!.drona_line);
  // The agent is told, and only when both tools are offered.
  assertStringIncludes(String(bodies[0].system), RECIPE_MEMORY_NOTE);
});

Deno.test("agent: with no remembered dish, build_recipe assumes and asks as before", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "paneer sabji", defaultMeal: "lunch", later: true, first: true },
    base(bodies, [[{ name: "build_recipe", input: { name: "Paneer sabji", parts: [{ name: "low fat paneer", amount: "60 g" }, { name: "oil" }] } }]], {
      parseFood: fakeParse(log), buildRecipe: true, warm: { memory: async () => foods() },
    }),
  );
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  assertEquals(log.sort(), ["5 g oil", "60 g low fat paneer"]);
  assert(out.result.parsed!.drona_line.endsWith("I assumed 1 tsp oil. Change it?"));
});

Deno.test("agent: without the switch a remembered dish changes nothing (no warm deps, no RECIPE_MEMORY_NOTE)", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "paneer sabji again", defaultMeal: "lunch", later: true, first: true },
    base(bodies, [[SABJI]], { parseFood: fakeParse(log), buildRecipe: true }),
  );
  assertEquals(out.kind, "log");
  // Oil takes the table's 1 tsp; onion the parse's one usual serving.
  assertEquals(log.sort(), ["5 g oil", "80 g low fat paneer", "onion"]);
  assertFalse(String(bodies[0].system).includes(RECIPE_MEMORY_NOTE));
});

// ── Review fixes ───────────────────────────────────────────────────────────

Deno.test("agent: a remembered part whose amount was itself assumed stays assumed, and the question still asks", async () => {
  const assumedOil: RecallFood[] = recallFoods([
    entry("Paneer sabji", 105, 230, daysAgo(1), {
      recipe: [{ name: "low fat paneer", grams: 60 }, { name: "oil", grams: 5, assumed: true }, { name: "onion", grams: 40 }],
    }),
  ], "precise", false, NOW);
  const log: string[] = [];
  const out = await runFoodAgent(
    { text: "paneer sabji again", defaultMeal: "lunch", later: true, first: true },
    base([], [[{ name: "build_recipe", input: { name: "Paneer sabji", parts: [{ name: "low fat paneer", amount: "60 g" }, { name: "oil" }, { name: "onion" }] } }]], {
      parseFood: fakeParse(log), buildRecipe: true, warm: { memory: async () => assumedOil },
    }),
  );
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  const dish = out.result.parsed!.items[0];
  // Onion was the user's last amount; oil was never the user's answer.
  assertEquals(dish.recipe?.map((p) => [p.name, p.grams, !!p.assumed]), [["low fat paneer", 60, false], ["oil", 5, true], ["onion", 40, false]]);
  assertStringIncludes(dish.assumption!, "Assumed 1 tsp oil.");
  assertStringIncludes(dish.assumption!, "From your last log: 40 g onion.");
  assertFalse(dish.assumption!.includes("From your last log: 5 g oil"));
  assert(out.result.parsed!.drona_line.endsWith("I assumed 1 tsp oil. Change it?"), out.result.parsed!.drona_line);
});

// The slow load's timer outlives the run on purpose: ops are not sanitized.
Deno.test({ name: "agent: build_recipe never waits on a slow memory load (3 s here)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const log: string[] = [];
  const t0 = Date.now();
  const slow = () => new Promise<RecallFood[]>((r) => setTimeout(() => r(SABJI_MEMORY), 3000));
  const events: unknown[] = [];
  const out = await runFoodAgent(
    { text: "paneer sabji again", defaultMeal: "lunch", later: true, first: true },
    base([], [[SABJI]], { parseFood: fakeParse(log), buildRecipe: true, warm: { memory: slow }, onEvent: (e) => events.push(e) }),
  );
  // The trace says the wait ran out.
  assertEquals(events.filter((e) => (e as { tool: string }).tool === "recipe_memory"), [{ tool: "recipe_memory", timed_out: true, waited_ms: 500 }]);
  assert(Date.now() - t0 < 2000, String(Date.now() - t0));
  assertEquals(out.kind, "log");
  // Built as with the switch off: the table's oil, the parse's onion serving.
  assertEquals(log.sort(), ["5 g oil", "80 g low fat paneer", "onion"]);
} });

Deno.test("supabaseThreadStore.turnsFrom: owned skips the second ownership read; without it, it checks", async () => {
  const { db, log } = fakeAdmin({
    food_threads: [{ id: "t1", user_id: "u1" }],
    food_thread_turns: [{ thread_id: "t1", seq: 1, role: "user", text: "hi" }],
  });
  const store = supabaseThreadStore(db);
  assertEquals((await store.turnsFrom!("u1", "t1", 1, 10, { owned: true }))!.length, 1);
  assertFalse(log.some((l) => l.table === "food_threads"));
  assertEquals(await store.turnsFrom!("u2", "t1", 1, 10), null);
  assert(log.some((l) => l.table === "food_threads"));
});

Deno.test("prompt truth: no matches sentence or memory_matches where the parse makes no memory decisions", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "calories in my jeera rice", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [[{ name: "parse_food", input: { text: "jeera rice" } }], [{ name: "reply", input: { text: "ok" } }]], {
      parseFood: async () => RICE_PARSE, warm: { memory: async () => foods() },
    }),
  );
  assertFalse(String(bodies[0].system).includes("Memory matches"));
  assertFalse(JSON.stringify(bodies[1].messages).includes("memory_matches"));
});

Deno.test("prompt truth: search_threads names copy_lines only when it is offered; read_thread says turns may be cut", async () => {
  const run = async (more: Partial<FoodAgentDeps>) => {
    const bodies: Record<string, unknown>[] = [];
    await runFoodAgent(
      { text: "x", defaultMeal: "lunch", later: true, card: CARD, recentTurns: appCopy(5, 14), warmThread: { first: null, turns: 14 } },
      base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { warm: { searchThreads: async () => [], readThread: async () => [] }, ...more }),
    );
    return bodies[0].tools as { name: string; description: string }[];
  };
  const without = await run({});
  assertFalse(without.find((t) => t.name === "search_threads")!.description.includes("copy_lines"));
  const read = without.find((t) => t.name === "read_thread")!.description;
  assertStringIncludes(read, "a turn may be cut short");
  assertFalse(read.includes("word for word"));
  const withCopy = await run({ readDiaryLines: async () => ({}) });
  assert(withCopy.some((t) => t.name === "copy_lines"));
  assertStringIncludes(withCopy.find((t) => t.name === "search_threads")!.description, "copy_lines");
});

/** A PostgREST-like fake over in-memory tables, recording every filter. */
function fakeAdmin(
  tables: Record<string, Record<string, unknown>[]>,
  /** A query to fail, judged by its table and its ops. */
  failWhen: (table: string, ops: { op: string; args: unknown[] }[]) => boolean = () => false,
) {
  const log: { table: string; op: string; args: unknown[] }[] = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let lim = Infinity;
      const mine: { op: string; args: unknown[] }[] = [];
      const q: Record<string, unknown> = {};
      const chain = (op: string, f: (...a: any[]) => void) => (...args: unknown[]) => { log.push({ table, op, args }); mine.push({ op, args }); f(...args); return q; };
      Object.assign(q, {
        select: chain("select", () => {}),
        eq: chain("eq", (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); }),
        not: chain("not", () => {}),
        neq: chain("neq", (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); }),
        gte: chain("gte", (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) >= v); }),
        in: chain("in", (c: string, v: unknown[]) => { rows = rows.filter((r) => v.includes(r[c])); }),
        order: chain("order", () => {}),
        limit: chain("limit", (n: number) => { lim = n; }),
        or: chain("or", (expr: string) => {
          const ands = [...expr.matchAll(/and\(card_id\.eq\.([^,]+),version\.eq\.(\d+)\)/g)].map((m) => [m[1], Number(m[2])] as const);
          const likes = [...expr.matchAll(/text\.ilike\.%([a-z0-9]+)%/g)].map((m) => m[1]);
          rows = rows.filter((r) =>
            ands.length ? ands.some(([c, v]) => r.card_id === c && r.version === v) : likes.some((w) => String(r.text).toLowerCase().includes(w))
          );
        }),
        maybeSingle: () => { log.push({ table, op: "maybeSingle", args: [] }); return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(failWhen(table, mine) ? { data: null, error: { message: "boom" } } : { data: rows.slice(0, lim), error: null }).then(res),
      });
      return q;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { db, log };
}

Deno.test("supabaseThreadStore.searchThreads: turns scored first; card lines read for the top 5 threads only (150+ cards)", async () => {
  const threads = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, user_id: "u1", started_at: `2026-11-${String(1 + (i % 7)).padStart(2, "0")}T08:00:00Z`, last_at: `2026-11-07T${String(i % 24).padStart(2, "0")}:00:00Z` }));
  // Paneer is in 8 threads' turns; every thread has 4 meal cards (160 cards).
  const turns = threads.flatMap((t, i) => [{ thread_id: t.id, seq: 1, role: "user", text: i < 8 ? `lunch was paneer sabji ${i}` : `two eggs ${i}` }]);
  const cards = threads.flatMap((t) => Array.from({ length: 4 }, (_, k) => ({ id: `${t.id}c${k}`, thread_id: t.id, version: 1, kind: "meal" })));
  const lines = cards.map((c) => ({ card_id: c.id, version: 1, name: "Paneer sabji", kcal: 210, line_no: 1 }));
  const { db, log } = fakeAdmin({ food_threads: threads, food_thread_turns: turns, food_cards: cards, food_card_lines: lines });
  const store = supabaseThreadStore(db);
  const hits = await store.searchThreads!("u1", ["paneer"], { excludeThreadId: null, sinceIso: "2026-10-20", limit: 5 });
  assertEquals(hits.length, 5);
  assert(hits.every((h) => Number(h.thread_id.slice(1)) < 8));
  // Cards read for the top 5 threads only, and their lines for those cards only.
  const cardIn = log.find((l) => l.table === "food_cards" && l.op === "in")!;
  assertEquals((cardIn.args[1] as string[]).length, 5);
  const lineOr = log.find((l) => l.table === "food_card_lines" && l.op === "or")!;
  assertEquals((String(lineOr.args[0]).match(/and\(/g) ?? []).length, 20);
  assertFalse(log.some((l) => l.table === "food_card_lines" && l.op === "limit"));
  assertEquals(hits[0].lines.length, 4);
  assert(hits[0].first?.startsWith("lunch was paneer sabji"));
});

Deno.test("rememberedPart: the same word set only, never a food that shares one word", () => {
  const parts = [{ name: "peanut butter", grams: 16 }, { name: "mustard oil", grams: 10 }, { name: "onion", grams: 40 }, { name: "red chilli", grams: 2 }];
  assertEquals(rememberedPart(parts, "butter"), null);
  assertEquals(rememberedPart(parts, "oil"), null);
  assertEquals(rememberedPart(parts, "groundnut oil"), null);
  assertEquals(rememberedPart(parts, "onions")?.grams, 40);
  assertEquals(rememberedPart(parts, "chilli red")?.grams, 2);
  assertEquals(rememberedPart(parts, "Mustard Oil")?.grams, 10);
});

Deno.test("the app sends its turns without the message in flight: nothing older means no read_thread and no count line", async () => {
  // As the app sends them (nutrition.tsx copies turnsRef before pushTurn):
  // 10 stored turns, the same 10 in recent_turns.
  const recent = appCopy(1, 10);
  assertFalse(hasOlderTurns({ first: null, turns: 10 }, recent, "make it 2 rotis"));
  assertEquals(warmThreadText({ first: null, turns: 10 }, recent, true, "make it 2 rotis"), null);
  // A client that also sent the message in flight as its last turn: that turn
  // is not a stored one, so the one stored turn it pushed out is older.
  const withInFlight = [...appCopy(2, 10), { role: "user" as const, text: "make it 2 rotis" }];
  assert(hasOlderTurns({ first: null, turns: 10 }, withInFlight, "make it 2 rotis"));
  assertStringIncludes(warmThreadText({ first: null, turns: 10 }, withInFlight, true, "make it 2 rotis")!, "the messages above carry the last 9");
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "make it 2 rotis", defaultMeal: "lunch", later: true, card: CARD, recentTurns: recent, warmThread: { first: null, turns: 10 } },
    base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { warm: { readThread: async () => [] } }),
  );
  assertFalse(toolNames(bodies[0]).includes("read_thread"));
  assertFalse(firstUser(bodies[0]).includes("earlier turns"));
});

Deno.test("supabaseThreadStore.load: a failed turn-1 read is said apart from no first message", async () => {
  const tables = {
    food_threads: [{ id: "t1", user_id: "u1", status: "open", last_at: "2026-11-08T10:00:00Z" }],
    food_cards: [],
    food_thread_turns: [{ thread_id: "t1", seq: 1, role: "user", text: "lunch" }, { thread_id: "t1", seq: 2, role: "drona", text: "ok" }],
  };
  const turnOne = (t: string, ops: { op: string; args: unknown[] }[]) => t === "food_thread_turns" && ops.some((o) => o.op === "eq" && o.args[0] === "seq" && o.args[1] === 1);
  const bad = await supabaseThreadStore(fakeAdmin(tables, turnOne).db).load("u1", "t1", { turns: true });
  assertEquals([bad?.first_text, bad?.first_text_error], [null, "boom"]);
  const good = await supabaseThreadStore(fakeAdmin(tables).db).load("u1", "t1", { turns: true });
  assertEquals([good?.first_text, good?.first_text_error], ["lunch", null]);
});

Deno.test("supabaseThreadStore.searchThreads: one chatty thread cannot hide the others (20 hits per thread)", async () => {
  const threads = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, user_id: "u1", started_at: "2026-11-05T08:00:00Z", last_at: `2026-11-07T0${i}:00:00Z` }));
  // t0 holds 400 turns naming paneer, read first; t1..t5 one each.
  const turns = [
    ...Array.from({ length: 400 }, (_, k) => ({ thread_id: "t0", seq: k + 1, role: "user", text: `paneer ${k}` })),
    ...threads.slice(1).map((t) => ({ thread_id: t.id, seq: 1, role: "user", text: "paneer sabji" })),
  ];
  const { db } = fakeAdmin({ food_threads: threads, food_thread_turns: turns, food_cards: [], food_card_lines: [] });
  const hits = await supabaseThreadStore(db).searchThreads!("u1", ["paneer"], { excludeThreadId: null, sinceIso: "2026-10-20", limit: 5 });
  assertEquals(hits.length, 5);
  assert(hits.some((h) => h.thread_id === "t0"));
  assert(hits.filter((h) => h.thread_id !== "t0").length >= 4, JSON.stringify(hits.map((h) => h.thread_id)));
});
