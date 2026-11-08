// Run with: deno test --allow-all supabase/functions/ai-coach/foodWarmMemory.test.ts
//
// Warm memory for the Precise food agent (FOOD_WARM_MEMORY, foodWarmMemory.ts).
// What these pin:
//   - off changes nothing: the opening message, the instructions and the
//     tools are exactly today's when the agent has no warm deps
//   - recall_food: the user's own foods by name, facts only, read only, memory
//     loaded once per message, at most 3 calls, a refusal for no name
//   - the matches block: code's name matches, labelled as not checked, with
//     code's calories, the card line it fits, and left out when empty
//   - the thread: its first message once it left the recent turns, its
//     summary, read_thread and search_threads (caps, refusals, one user only)
//   - the summary: one background call past the turns the app sends, facts
//     only, failures change nothing
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
import type { ParsedItem, ParseMealResult } from "./parseMeal.ts";
import { BUILD_RECIPE_TOOL, RECIPE_NOTE } from "./recipe.ts";
import type { MemoryEntry } from "./userFoodMemory.ts";
import { memoryThreadStore, type ThreadHit, type ThreadTurn } from "./foodThreads.ts";
import {
  type FoodAgentWarm,
  matchesBlock,
  MAX_RECALL_PER_RUN,
  parseFoodWarmMemoryMode,
  readSummary,
  recallAnswer,
  type RecallFood,
  recallFoods,
  RECIPE_MEMORY_NOTE,
  SUMMARY_TURNS_FROM,
  warmThreadText,
  writeThreadSummary,
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
    warmThread: { first: "lunch was jeera rice and dal", summary: "User said the dal had ghee.", turns: 14 } };
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

Deno.test("agent: recall_food in the same turn as a card change holds the change until the agent has read it", async () => {
  const bodies: Record<string, unknown>[] = [];
  let edits = 0;
  await runFoodAgent(
    { text: "rice as usual", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [
      [{ name: "recall_food", input: { name: "jeera rice" } }, { name: "edit_line", input: { line_id: "L1", change: "150 g" } }],
      [{ name: "reply", input: { text: "ok" } }],
    ], { warm: { memory: async () => foods() }, editLine: async () => { edits++; return { parsed: null, declined: null, usage: USAGE, tool_calls: [], steps: [], iterations: 1 } as unknown as ParseMealResult; } }),
  );
  assertEquals(edits, 0);
  assertStringIncludes(JSON.stringify(bodies[1].messages), "Not applied yet: this turn also reads data.");
});

// ── The matches block ──────────────────────────────────────────────────────

Deno.test("matchesBlock: name matches for this message, code's calories, the card line, marked not checked", () => {
  const b = matchesBlock(foods(), "lunch was 100g jeera rice and dal", CARD)!;
  assertStringIncludes(b, "a name match only, not checked");
  assertStringIncludes(b, `- "Jeera rice": usually 100 g, 171 kcal at that amount; logged 3 times in the last 10 days; same name as card line L1.`);
  // Dal is on the card but not in memory: not listed. Oats are in memory but
  // not in the message: not listed.
  assertFalse(b.includes("oats"));
  assertFalse(b.includes("Dal"));
});

Deno.test("matchesBlock: a single shared word is not a match; nothing passes means no block", () => {
  // "rice" alone is well under the cutoff for "jeera rice".
  assertEquals(matchesBlock(foods(), "plain rice please", null), null);
  assertEquals(matchesBlock(foods(), "make it two", CARD), null);
  assertEquals(matchesBlock([], "jeera rice", CARD), null);
});

Deno.test("matchesBlock: a saved food with no amount in the window says per 100 g and when it was last logged", () => {
  const b = matchesBlock(foods(), "milky mist low fat paneer 60 g", null)!;
  assertStringIncludes(b, `"Milky Mist low fat paneer": 254 kcal per 100 g; last logged ${daysAgo(4).slice(0, 10)}.`);
});

Deno.test("agent: the matches block goes in the opening message, under the card, and is small", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "the jeera rice was 150 g", defaultMeal: "lunch", later: true, card: CARD },
    base(bodies, [[{ name: "reply", input: { text: "ok" } }]], { warm: { memory: async () => foods() } }),
  );
  const open = firstUser(bodies[0]);
  const card = open.indexOf("(card on screen:");
  const block = open.indexOf("(Foods in the user's memory");
  assert(card >= 0 && block > card, open);
  // Well under 150 tokens (about 4 characters a token).
  const text = open.slice(block, open.indexOf(")", block) + 1);
  assert(text.length < 600, String(text.length));
});

// ── The thread ─────────────────────────────────────────────────────────────

Deno.test("warmThreadText: the first message once it left the recent turns, the summary, and older turns", () => {
  const w = { first: "lunch was 100g jeera rice and paneer sabji of 60 g paneer", summary: "User said the sabji had 60 g paneer.", turns: 14 };
  const recent = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "drona" : "user") as "user" | "drona", text: `turn ${i + 5}` }));
  const t = warmThreadText(w, recent, true)!;
  assertStringIncludes(t, `First message of this thread: "lunch was 100g jeera rice and paneer sabji of 60 g paneer"`);
  assertStringIncludes(t, "Summary of the earlier turns, facts the user stated: User said the sabji had 60 g paneer.");
  assertStringIncludes(t, "This thread has 14 earlier turns; the messages above carry the last 10.");
  // Still in the recent turns (cut by the app): not repeated.
  const withFirst = [{ role: "user" as const, text: "lunch was 100g jeera rice" }];
  assertFalse((warmThreadText({ ...w, summary: null }, withFirst, false) ?? "").includes("First message"));
  // Cut to 400 characters.
  const long = warmThreadText({ first: "a".repeat(900), summary: null, turns: 1 }, [], false)!;
  assert(long.length < 460, String(long.length));
  assertEquals(warmThreadText(null, [], true), null);
});

Deno.test("memoryThreadStore: warm, turnsFrom and searchThreads read one user's threads only", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", "t1");
  await s.addTurns("t1", 1, [{ role: "user", text: "lunch was paneer sabji" }, { role: "drona", text: "On the card." }], "c1");
  await s.addTurns("t1", 3, [{ role: "user", text: "make it 60 g paneer" }], "c2");
  await s.createCard("t1", "card1", "meal", [{ line_id: "L1", name: "Paneer sabji", grams: 120, quantity: 1, unit: "serving", kcal: 210, protein_g: 12, carb_g: 8, fat_g: 14 }], "c1", "lunch");
  await s.ensure("u1", "t2");
  await s.addTurns("t2", 1, [{ role: "user", text: "two eggs" }], "c3");
  await s.ensure("u2", "t3");
  await s.addTurns("t3", 1, [{ role: "user", text: "paneer tikka" }], "c4");
  assertEquals(await s.warm!("u1", "t1"), { first: "lunch was paneer sabji", summary: null, turns: 3 });
  assertEquals(await s.warm!("u2", "t1"), null);
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
    { text: "what did I say first", defaultMeal: "lunch", later: true, card: CARD, recentTurns: recent, warmThread: { first: "turn 1", summary: null, turns: 14 } },
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
    { text: "x", defaultMeal: "lunch", later: true, card: CARD, recentTurns: recent, warmThread: { first: "turn 5", summary: null, turns: 10 } },
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

// ── The summary ────────────────────────────────────────────────────────────

async function longThread(n: number) {
  const s = memoryThreadStore();
  await s.ensure("u1", "t1");
  await s.addTurns("t1", 1, Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? "drona" : "user") as "user" | "drona", text: `turn ${i + 1}` })), "c1");
  return s;
}

Deno.test("writeThreadSummary: no call while the app still sends every turn", async () => {
  const s = await longThread(SUMMARY_TURNS_FROM);
  let calls = 0;
  const out = await writeThreadSummary(s, "u1", "t1", "haiku", async () => { calls++; return { ok: true, data: {} }; });
  assertEquals(out, { written: false, reason: "short_thread" });
  assertEquals(calls, 0);
});

Deno.test("writeThreadSummary: one call over the older turns only, the summary saved and shown next time", async () => {
  const s = await longThread(14);
  const bodies: Record<string, unknown>[] = [];
  const out = await writeThreadSummary(s, "u1", "t1", "haiku", async (b) => {
    bodies.push(b);
    return { ok: true, data: { content: [{ type: "text", text: "User said the sabji had 60 g paneer — low fat.\nUser uses Amul ghee.\nThird line." }], usage: { input_tokens: 90, output_tokens: 20 } } };
  });
  assertEquals(bodies.length, 1);
  const content = String((bodies[0].messages as { content: string }[])[0].content);
  // Turns 1..4 are the ones the app no longer sends.
  assertStringIncludes(content, "4. Drona: turn 4");
  assertFalse(content.includes("turn 5"));
  assert(out.written);
  const w = await s.warm!("u1", "t1");
  assertEquals(w?.summary, "User said the sabji had 60 g paneer, low fat.\nUser uses Amul ghee.");
});

Deno.test("writeThreadSummary: a failed call or NONE writes nothing", async () => {
  const s = await longThread(14);
  assertEquals((await writeThreadSummary(s, "u1", "t1", "haiku", async () => ({ ok: false }))).written, false);
  assertEquals(
    (await writeThreadSummary(s, "u1", "t1", "haiku", async () => ({ ok: true, data: { content: [{ type: "text", text: "NONE" }] } }))).written,
    false,
  );
  assertEquals((await s.warm!("u1", "t1"))?.summary, null);
  assertEquals(await writeThreadSummary(s, "u1", "t1", "haiku", async () => { throw new Error("boom"); }), { written: false, reason: "threw" });
  assertEquals(readSummary({ ok: true, data: { content: [{ type: "text", text: "" }] } }), null);
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
