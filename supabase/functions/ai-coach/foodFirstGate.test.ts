// Run with: deno test --allow-all supabase/functions/ai-coach/foodFirstGate.test.ts
//
// Step 3 of .planning/precise-food-logger-plan.md (FOOD_FIRST_GATE): the first
// message of a thread gets one Jev yes/no, "a fully plain food log that asks
// for nothing else?". What these pin:
//   - which messages go through the gate (first ones, Precise, switch on)
//   - off asks nothing new: the router's Jev call and decision are unchanged
//   - plain at or over the floor serves the parse; under it, or no answer, the agent
//   - the agent takes the running parse for the same words, never a second one
//   - a failed agent serves the running parse when it found food (log wins every tie)
//   - the first-message agent gets its own opening, the later prompt is unchanged

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  firstMessageGoesToGate,
  isPlainFirstLog,
  parseFoodFirstGateMode,
  PLAIN_LOG_FLOOR,
  routeFoodIntent,
} from "./foodIntent.ts";
import { configureFoodBar, runFirstMessage, sameParseText } from "./foodBar.ts";
import { FIRST_NOTE, FOOD_AGENT_SYSTEM_FIRST, FOOD_AGENT_SYSTEM_LATER } from "./foodAgent.ts";
import type { FoodIntentDecision } from "./foodIntent.ts";
import type { ParsedItem, ParseMealResult } from "./parseMeal.ts";

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };

function item(name: string, kcal: number): ParsedItem {
  return {
    food_id: null, food_name: name, quantity: 1, serving_label: "serving", grams: 100, kcal,
    protein_g: 1, carb_g: 1, fat_g: 1, source: "catalog", confidence: "high", assumption: null, meal_type: "lunch",
  } as unknown as ParsedItem;
}
function result(items: ParsedItem[]): ParseMealResult {
  return {
    parsed: items.length ? { meal_type: "lunch", items, drona_line: "Here it is.", corrects_previous: false } : null,
    declined: items.length ? null : { message: "What did you have?" },
    usage: USAGE, tool_calls: [], steps: [], iterations: 1,
  } as ParseMealResult;
}

const GATE = { mode: "on" as const, precise: true, supportsCreate: true, hasModelKey: true, turns: 0, cardLines: 0, pending: false };

Deno.test("FOOD_FIRST_GATE: anything but 'on' is off", () => {
  assertEquals(parseFoodFirstGateMode("on"), "on");
  assertEquals(parseFoodFirstGateMode(" ON "), "on");
  for (const v of [undefined, "", "off", "shadow", "yes"]) assertEquals(parseFoodFirstGateMode(v), "off");
});

Deno.test("firstMessageGoesToGate: only a first message, in Precise, with the switch on", () => {
  assert(firstMessageGoesToGate(GATE));
  assertFalse(firstMessageGoesToGate({ ...GATE, mode: "off" }));
  assertFalse(firstMessageGoesToGate({ ...GATE, precise: false }));
  assertFalse(firstMessageGoesToGate({ ...GATE, supportsCreate: false }));
  assertFalse(firstMessageGoesToGate({ ...GATE, hasModelKey: false }));
  // Not a first message: an earlier turn, a card (whole or cut), a question waiting.
  assertFalse(firstMessageGoesToGate({ ...GATE, turns: 1 }));
  assertFalse(firstMessageGoesToGate({ ...GATE, cardLines: 3 }));
  assertFalse(firstMessageGoesToGate({ ...GATE, pending: true }));
});

Deno.test("isPlainFirstLog: plain only at or over the floor; no answer is not plain", () => {
  assert(isPlainFirstLog({ plainLog: PLAIN_LOG_FLOOR }));
  assert(isPlainFirstLog({ plainLog: 0.97 }));
  assertFalse(isPlainFirstLog({ plainLog: PLAIN_LOG_FLOOR - 0.01 }));
  assertFalse(isPlainFirstLog({ plainLog: null }));
  assertFalse(isPlainFirstLog({}));
  assertFalse(isPlainFirstLog(null));
});

/** A fake Jev that records each request's questions and answers log + the gate. */
function fakeJev(plain: number, seen: string[][]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    seen.push(Object.keys(body.questions).sort());
    return new Response(JSON.stringify({
      model: "jev-test",
      usage: { input_tokens: 10, output_tokens: 1 },
      answers: {
        intent: { type: "choice", choice: "log", probabilities: { log: 0.9 }, confidence: 0.9 },
        has_food: { type: "noul", noul: 0.95 },
        plain: { type: "noul", noul: plain },
      },
    }), { status: 200 });
  }) as typeof fetch;
}

Deno.test("routeFoodIntent: off asks no gate question and adds no field; on reads it from the same call", async () => {
  const seen: string[][] = [];
  const ctx = { recentTurns: [], pendingMeal: null, card: null };
  const off = await routeFoodIntent("2 eggs", { jev: { apiKey: "k", timeoutMs: 1000, fetchFn: fakeJev(0.9, seen) } }, ctx);
  assertFalse("plainLog" in off);
  assertEquals(seen[0], ["has_food", "intent"]);
  const on = await routeFoodIntent("2 eggs", { askPlain: true, jev: { apiKey: "k", timeoutMs: 1000, fetchFn: fakeJev(0.9, seen) } }, ctx);
  assertEquals(on.plainLog, 0.9);
  assertEquals(seen[1], ["has_food", "intent", "plain"]);
  // One call: the gate rides on the router's own request.
  assertEquals(seen.length, 2);
  // The routing verdict itself is the same either way.
  assertEquals({ ...on, plainLog: undefined }, { ...off, plainLog: undefined });
});

Deno.test("routeFoodIntent: Jev down means no gate answer, which is the agent", async () => {
  const down = (async () => new Response("no", { status: 400 })) as unknown as typeof fetch;
  const d = await routeFoodIntent("2 eggs", { askPlain: true, jev: { apiKey: "k", timeoutMs: 1000, fetchFn: down } });
  assertEquals(d.plainLog, null);
  assertFalse(isPlainFirstLog(d));
});

Deno.test("sameParseText: case, spacing and closing punctuation aside", () => {
  assert(sameParseText("Had 2 samosas, how much protein?", "had 2  samosas, how much protein"));
  assertFalse(sameParseText("2 samosas", "had 2 samosas, how much protein?"));
  assertFalse(sameParseText("", ""));
});

// ── runFirstMessage ────────────────────────────────────────────────────────

type Use = { name: string; input: Record<string, unknown> };
function configure(script: Use[][] | null, bodies: Record<string, unknown>[] = []): () => number {
  let n = 0;
  configureFoodBar({
    intentMode: "on",
    anthropicApiKey: "test",
    parseModel: "haiku",
    agentModel: "sonnet",
    jev: null,
    callAnthropic: (async (b: Record<string, unknown>) => {
      bodies.push(JSON.parse(JSON.stringify(b)));
      if (!script) return { ok: false, status: 500, body: "down" };
      const uses = script[Math.min(n, script.length - 1)];
      n++;
      return {
        ok: true,
        data: {
          usage: { input_tokens: 100, output_tokens: 20 },
          content: uses.map((u, i) => ({ type: "tool_use", id: `t${n}_${i}`, name: u.name, input: u.input })),
        },
      };
    }) as never,
  });
  return () => n;
}

function args(text: string, plainLog: number | null, extraParses: string[]) {
  const d: FoodIntentDecision = { intent: "log", source: "jev", confidence: 0.9, note: "t", savedMatch: null, plainLog };
  return {
    intentP: Promise.resolve(d),
    supportsCreate: true,
    text,
    mealHint: "lunch" as const,
    localHour: 13,
    localDate: "2026-11-07",
    mode: "super" as const,
    savedMealsP: Promise.resolve([]),
    readDiary: async () => ({ meals: [] }),
    contextPromise: Promise.resolve({ recentFoods: [], todayTotals: null, targets: null }),
    // A second parse would come through here; the test fails if it does.
    parseDeps: () => {
      extraParses.push("parse");
      throw new Error("a second parse started");
    },
    logUsage: () => {},
    userId: "u",
    recentTurns: [],
    pendingMeal: null,
    card: null,
  };
}

Deno.test("runFirstMessage: plain serves the running parse; the agent never runs", async () => {
  const calls = configure([[{ name: "reply", input: { text: "hi" } }]]);
  const extra: string[] = [];
  const r = await runFirstMessage({ agent: args("2 eggs and toast", 0.95, extra), parse: Promise.resolve(result([item("Egg", 155)])) });
  assertEquals(r.gate.to, "parse");
  assertEquals(r.outcome.action, "log");
  assertEquals(r.result.parsed?.items[0].food_name, "Egg");
  assertEquals(calls(), 0);
  assertEquals(extra.length, 0);
});

Deno.test("runFirstMessage: not plain goes to the agent, which logs AND answers with the running parse", async () => {
  const text = "lunch was dal rice, too much for a cut?";
  const bodies: Record<string, unknown>[] = [];
  configure([[
    { name: "log_food", input: { text, meal_type: "lunch", summary: "Dal rice." } },
    { name: "reply", input: { text: "About 450 kcal, fine for a cut lunch." } },
  ]], bodies);
  const extra: string[] = [];
  const r = await runFirstMessage({ agent: args(text, 0.1, extra), parse: Promise.resolve(result([item("Dal rice", 450)])) });
  assertEquals(r.gate.to, "agent");
  assertEquals(r.gate.parseReused, 1);
  assertEquals(extra.length, 0);
  assertEquals(r.outcome.action, "log");
  assert(r.outcome.answered);
  assertEquals(r.result.parsed?.items[0].food_name, "Dal rice");
  assertEquals(r.result.parsed?.drona_line, "About 450 kcal, fine for a cut lunch.");
  // The first-message agent: its own opening and the running-parse note.
  assert(String(bodies[0].system).startsWith(FOOD_AGENT_SYSTEM_FIRST));
  assert(String(bodies[0].system).includes(FIRST_NOTE));
});

Deno.test("runFirstMessage: no gate answer is the agent; a failed agent serves the running parse", async () => {
  configure(null);
  const r = await runFirstMessage({ agent: args("2 eggs", null, []), parse: Promise.resolve(result([item("Egg", 155)])) });
  assertEquals(r.gate.to, "agent");
  assertEquals(r.outcome.agent?.kind, "failed");
  assertEquals(r.outcome.action, "log");
  assertEquals(r.result.parsed?.items[0].food_name, "Egg");
});

Deno.test("runFirstMessage: an agent reply with no food does not wait for the parse", async () => {
  configure([[{ name: "reply", input: { text: "Hi! Tell me what you had." } }]]);
  let release!: (r: ParseMealResult) => void;
  const slow = new Promise<ParseMealResult>((res) => { release = res; });
  const r = await runFirstMessage({ agent: args("hi", 0.01, []), parse: slow });
  assertEquals(r.outcome.action, "reply");
  assertEquals(r.firstParse, null);
  release(result([]));
});

Deno.test("the first-message prompt differs only in its opening; the later prompt is unchanged", () => {
  assert(FOOD_AGENT_SYSTEM_FIRST !== FOOD_AGENT_SYSTEM_LATER);
  assert(FOOD_AGENT_SYSTEM_LATER.includes("You answer every message after the first one"));
  assert(FOOD_AGENT_SYSTEM_FIRST.includes("You answer the first message of this food conversation"));
  assertEquals(FOOD_AGENT_SYSTEM_FIRST.length - FOOD_AGENT_SYSTEM_FIRST.indexOf(": you put food"), FOOD_AGENT_SYSTEM_LATER.length - FOOD_AGENT_SYSTEM_LATER.indexOf(": you put food"));
});
