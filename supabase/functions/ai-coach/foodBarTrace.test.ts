import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildFoodBarTraceRow,
  capped,
  fitSteps,
  isRefusal,
  STEPS_BYTES_MAX,
  STEP_PAYLOAD_MAX,
  createFoodBarTrace,
  fallbackReason,
  fromParseSteps,
  orderSteps,
  readRequestView,
  routerView,
  sawContext,
  servedText,
  servedView,
  summarize,
} from "./foodBarTrace.ts";

// A fake clock, so every at_ms in these tests is exact.
function clock(start = 1000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

Deno.test("the 15:23:06 case: the parse found a meal, the box served a save card, and the row says create", () => {
  // Live 2026-11-05: parse_traces said outcome "meal" for this message while
  // the app drew a save card. The row must say what was SERVED.
  const served = servedView({ parsed: null, declined: null, proposal: null, create: { tool: "create_custom_meal", input: { name: "Gym shake", log_now: false, items: [{}, {}] } } }, 200, "create");
  assertEquals(served.kind, "create");
  assertEquals(served.create, { tool: "create_custom_meal", name: "Gym shake", log_now: false, items: 2 });
});

Deno.test("a reply rides the decline channel, so only the server's action tells it from a decline", () => {
  const body = { parsed: null, declined: { message: "Hey! Tell me what you ate." }, proposal: null };
  assertEquals(servedView(body, 200, "reply").kind, "reply");
  assertEquals(servedView(body, 200, "log").kind, "declined");
  // The words the user saw are a column of their own.
  assertEquals(servedText(servedView(body, 200, "reply")), "Hey! Tell me what you ate.");
});

Deno.test("a served meal keeps each line's name, amount and calories", () => {
  const v = servedView({
    parsed: { meal_type: "lunch", drona_line: "Logged.", items: [{ food_name: "Roti", quantity: 2, serving_label: "piece", grams: 80, kcal: 240, source: "catalog", protein_g: 8 }] },
    declined: null,
    logged: { sections: [] },
  }, 200, "log");
  assertEquals(v.kind, "meal");
  assertEquals(v.items, [{ food_name: "Roti", quantity: 2, serving_label: "piece", grams: 80, kcal: 240, source: "catalog" }]);
  assertEquals(v.logged, { sections: [] });
});

Deno.test("a cap or a cooldown is a refused message, not an error", () => {
  assertEquals(servedView({ error: "free_cap_hit" }, 402, null).kind, "refused");
  assertEquals(servedView({ error: "Rate limit exceeded" }, 429, null).kind, "refused");
  assertEquals(servedView({ error: "parse_failed" }, 502, null).kind, "error");
});

Deno.test("the router row says why Jev was not used, and says so when the router never ran", () => {
  const timedOut = routerView({
    intent: "log", source: "default", confidence: null, note: "no router available", savedMatch: null,
    jevMiss: "timeout:Jev call exceeded 2500ms",
  }, 2510);
  assertEquals(timedOut.source, "default");
  assertEquals(timedOut.jev_miss, "timeout:Jev call exceeded 2500ms");
  assertEquals(timedOut.ms, 2510);

  const used = routerView({ intent: "create", source: "jev", confidence: 0.82, note: "jev x", savedMatch: { id: "s1", name: "Shake", confidence: 0.9 }, resumeAgent: false }, 640);
  assertEquals([used.intent, used.confidence, used.jev_miss, used.saved_match?.name], ["create", 0.82, null, "Shake"]);

  assertEquals(routerView(null, null).jev_miss, "router_did_not_run");
});

Deno.test("what the app sent: counts before any cap, turns as the models saw them", () => {
  const body = {
    text: "make it a meal", speed: "fast", supports: ["food_create", "variant_swap"],
    previous_items: [{}, {}, {}], previous_words: "2 eggs and toast",
    recent_turns: Array.from({ length: 9 }, (_, i) => ({ role: "user", text: `t${i}` })),
  };
  const v = readRequestView(body, { recentTurns: [{ role: "user", text: "x".repeat(900) }], pendingMeal: null }, {
    text: "make it a meal", mealHint: null, localDate: "2026-11-05", localHour: 15, streamed: true, autoLog: false, clientId: null, canCreate: true,
  });
  assertEquals(v.previous_items_sent, 3);
  assertEquals(v.recent_turns_sent, 9);
  assertEquals(v.recent_turns.length, 1);
  assertEquals(v.recent_turns[0].text.length, 300);
  assertEquals(v.previous_words, "2 eggs and toast");
  assertEquals(v.supports, ["food_create", "variant_swap"]);
});

Deno.test("steps come out in time order; an untimed step keeps its place in its own source", () => {
  const out = orderSteps([
    { src: "router", tool: "food_intent", at_ms: 700 },
    { src: "parse", tool: "extract", at_ms: 300 },
    { src: "parse", tool: "pending_meal" }, // untimed: rides on extract's 300
    { src: "parse", tool: "search_foods", at_ms: 900 },
    { src: "router", tool: "decideFoodAction", at_ms: 1500 },
  ]);
  assertEquals(out.map((s) => s.tool), ["extract", "pending_meal", "food_intent", "search_foods", "decideFoodAction"]);
});

Deno.test("the collector stamps steps and calls against the request start, and a scope prefixes them", () => {
  const c = clock(10_000);
  const t = createFoodBarTrace("req-1", 10_000, c.now);
  c.tick(250);
  t.step({ src: "router", tool: "food_intent" });
  // A call that took 400 ms and ended now started 400 ms ago.
  c.tick(500);
  t.call({ stage: "extract", provider: "anthropic", model: "haiku", ms: 400, ok: true, input_tokens: 10, output_tokens: 5, saw_recent_turns: true, saw_card: false });
  const agent = t.scoped("agent_parse");
  agent.step({ src: "parse", tool: "search_foods" });
  agent.call({ stage: "decide", provider: "anthropic", model: "haiku", ms: 0, ok: true, input_tokens: 1, output_tokens: 1, saw_recent_turns: false, saw_card: false });
  assertEquals(t.steps.map((s) => [s.src, s.tool, s.at_ms]), [["router", "food_intent", 250], ["agent_parse:parse", "search_foods", 750]]);
  assertEquals(t.calls.map((x) => [x.stage, x.at_ms]), [["extract", 350], ["agent_parse:decide", 750]]);
});

Deno.test("sawContext reads what was actually sent", () => {
  const withBoth = { messages: [{ role: "user", content: JSON.stringify({ user_text: "x", recent_turns: [{ user: "hi" }], previous_meal: { items: [] } }) }] };
  assertEquals(sawContext(withBoth), { saw_recent_turns: true, saw_card: true });
  assertEquals(sawContext({ messages: [{ role: "user", content: "2 eggs" }] }), { saw_recent_turns: false, saw_card: false });
  // A card with no earlier turns: the list is there and empty.
  const emptyTurns = { messages: [{ role: "user", content: JSON.stringify({ text: "x", recent_turns: [], previous_meal: { items: [] } }) }] };
  assertEquals(sawContext(emptyTurns), { saw_recent_turns: false, saw_card: true });
});

Deno.test("fallback says why the served action is not the planned one", () => {
  assertEquals(fallbackReason({ planned: "create", action: "log", followupError: "no_tool_call", agentRan: false }), "create_failed:no_tool_call");
  assertEquals(fallbackReason({ planned: "agent", action: "log", agentRan: false }), "agent_did_not_start");
  assertEquals(fallbackReason({ planned: "agent", action: "reply", agentKind: "failed", agentReason: "http_529", agentRan: true }), "agent_failed:http_529");
  assertEquals(fallbackReason({ planned: "agent", action: "create", agentKind: "create", agentRan: true }), null);
  assertEquals(fallbackReason({ planned: "log", action: "log", agentRan: false }), null);
});

Deno.test("one row: the planned and served actions, sums over Anthropic only, steps merged in order", () => {
  const c = clock(0);
  const t = createFoodBarTrace("req-9", 0, c.now);
  t.call({ stage: "jev:food_intent", provider: "typesafe", model: "jev-1", ms: 600, at_ms: 0, ok: true, input_tokens: 900, output_tokens: 3, saw_recent_turns: true, saw_card: true, questions: 3 });
  t.call({ stage: "extract", provider: "anthropic", model: "haiku", ms: 800, at_ms: 10, ok: true, input_tokens: 1200, output_tokens: 300, saw_recent_turns: true, saw_card: true });
  t.call({ stage: "create", provider: "anthropic", model: "haiku", ms: 900, at_ms: 1500, ok: true, input_tokens: 700, output_tokens: 200, saw_recent_turns: true, saw_card: false });
  t.step({ src: "router", tool: "food_intent", at_ms: 620 });
  t.step({ src: "router", tool: "decideFoodAction", at_ms: 1490, result: "create" });
  t.step({ src: "create", tool: "draftFoodCreate", at_ms: 2400 });
  const parseSteps = fromParseSteps("parse", [
    { iter: 0, tool: "extract_done", at_ms: 820 },
    { iter: 1, tool: "search_foods", at_ms: 900, input: { query: "whey" }, result: { hits: 4 } },
  ]);
  const row = buildFoodBarTraceRow({
    requestId: "req-9",
    userId: "user_1",
    request: readRequestView({ text: "save my shake" }, { recentTurns: [], pendingMeal: null }, {
      text: "save my shake", mealHint: null, localDate: null, localHour: null, streamed: true, autoLog: false, clientId: null, canCreate: true,
    }),
    router: routerView({ intent: "create", source: "jev", confidence: 0.91, note: "jev", savedMatch: null }, 620),
    card: { lines: 2, may_be_cut: false, open: true },
    planned: "create",
    action: "create",
    fallback: null,
    answeredBy: "create_call",
    tierUsed: "fast",
    served: servedView({ create: { tool: "create_custom_food", input: { name: "Shake" } } }, 200, "create"),
    steps: [...t.steps, ...parseSteps],
    calls: t.calls,
    latencyMs: 2410.4,
    status: "ok",
    error: null,
  });
  assertEquals(row.request_id, "req-9");
  assertEquals([row.planned_action, row.served_action, row.served_kind], ["create", "create", "create"]);
  assertEquals([row.router_intent, row.router_confidence, row.router_source], ["create", 0.91, "jev"]);
  assertEquals([row.card_open, row.card_lines], [true, 2]);
  // Jev's tokens are its own (priced by model_pricing); the sums are Anthropic's.
  assertEquals([row.input_tokens, row.output_tokens, row.anthropic_calls, row.jev_calls], [1900, 500, 2, 1]);
  const steps = row.steps as { tool: string }[];
  assertEquals(steps.map((s) => s.tool), ["food_intent", "extract_done", "search_foods", "decideFoodAction", "draftFoodCreate"]);
  assertEquals(row.latency_ms, 2410);
  assertEquals(row.served_text, "save card: Shake");
  assertEquals(row.calls_dropped, 0);
  assert(Array.isArray(row.model_calls));
});

Deno.test("summaries are cut, never dropped, and say how long the whole was", () => {
  assertEquals(summarize(null), null);
  assertEquals(summarize("short"), "short");
  const long = summarize({ rows: "x".repeat(1000) }, 50)!;
  assert(long.startsWith('{"rows":"xxx'));
  assert(long.endsWith("…(1011)"));
});

// ── Wiring: a real parse run reports to the trace ───────────────────────────
import { type ParseMealDeps, type ParseModelCall, runParseMeal } from "./parseMeal.ts";

function quickParseDeps(calls: ParseModelCall[], withTrace: boolean): ParseMealDeps {
  return {
    anthropicApiKey: "k", model: "haiku-test", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [],
    backfillOffFood: async () => null,
    getFoodPer100: async () => null,
    getFoodServings: async () => [],
    ...(withTrace ? { stepClock: Date.now() - 50, onModelCall: (c: ParseModelCall) => { calls.push(c); } } : {}),
    fetchFn: (async () =>
      new Response(JSON.stringify({
        stop_reason: "tool_use",
        usage: { input_tokens: 120, output_tokens: 30 },
        content: [{
          type: "tool_use", name: "estimate_meal", input: {
            declined: false, meal_type_from_text: null, items: [{
              name: "banana", brand: null, quantity: 1, unit: "piece", prep: null,
              label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null,
              est_kcal: 105, est_protein_g: 1, est_carb_g: 27, est_fat_g: 0, est_total_g: 118,
            }],
          },
        }],
      }), { status: 200 })) as typeof fetch,
  };
}

Deno.test("a parse with the trace hooks records each model call with its stage, and stamps its steps", async () => {
  const calls: ParseModelCall[] = [];
  const input = {
    text: "a banana", localHour: 9, mealHint: null, mode: "fast" as const, recentFoods: [], todayTotals: null, targets: null,
    recentTurns: [{ role: "user" as const, text: "hi" }, { role: "drona" as const, text: "Hey" }],
  };
  const r = await runParseMeal(quickParseDeps(calls, true), input);
  assertEquals(r.parsed?.items.map((i) => i.food_name), ["banana"]);
  assert(calls.length >= 1);
  assertEquals(calls[0].stage, "extract");
  assertEquals([calls[0].model, calls[0].input_tokens, calls[0].output_tokens, calls[0].ok], ["haiku-test", 120, 30, true]);
  assertEquals(calls[0].saw_card, false);
  const timed = r.steps.filter((s) => typeof s.at_ms === "number");
  assert(timed.length > 0, "steps carry at_ms");
  assert(timed.every((s) => s.at_ms! >= 50));
});

Deno.test("without the hooks a parse is exactly as before: no at_ms on any step", async () => {
  const calls: ParseModelCall[] = [];
  const r = await runParseMeal(quickParseDeps(calls, false), {
    text: "a banana", localHour: 9, mealHint: null, mode: "fast" as const, recentFoods: [], todayTotals: null, targets: null,
  });
  assertEquals(calls.length, 0);
  assertEquals(r.steps.filter((s) => s.at_ms !== undefined).length, 0);
});

Deno.test("a source whose first step is untimed stays where it was listed, not at the front", () => {
  const out = orderSteps([
    { src: "parse", tool: "extract", at_ms: 300 },
    { src: "router", tool: "food_intent", at_ms: 700 },
    { src: "edge", tool: "__auto_log" }, // untimed, and edge has no earlier step
    { src: "edge", tool: "__edge_timing" },
  ]);
  assertEquals(out.map((s) => s.tool), ["extract", "food_intent", "__auto_log", "__edge_timing"]);
});

Deno.test("a huge step payload is cut to a string; an ordinary one is kept whole", () => {
  const small = { query: "whey", hits: 4 };
  assertEquals(capped(small), small);
  const big = { rows: "x".repeat(STEP_PAYLOAD_MAX + 10) };
  const c = capped(big);
  assertEquals(typeof c, "string");
  assert((c as string).length < STEP_PAYLOAD_MAX + 20);
  const steps = fromParseSteps("parse", [{ tool: "search_foods", input: { query: "whey" }, result: big }]);
  assertEquals(typeof steps[0].result, "string");
  assertEquals(steps[0].input, { query: "whey" });
});

Deno.test("a router still running when the row is written says so", () => {
  assertEquals(routerView(null, null, "router_still_running").jev_miss, "router_still_running");
});

Deno.test("only 400, 402 and 429 are refusals; any other failure is an error", () => {
  assertEquals([400, 402, 429].map(isRefusal), [true, true, true]);
  assertEquals([401, 404, 500, 502].map(isRefusal), [false, false, false, false]);
  assertEquals(servedView({ error: "Unauthorized" }, 401, null).kind, "error");
});

Deno.test("a long run of big steps stops at the byte budget and counts what it dropped", () => {
  const big = "y".repeat(STEP_PAYLOAD_MAX - 100);
  const steps = Array.from({ length: 200 }, (_, i) => ({ src: "agent_parse:parse", tool: `s${i}`, at_ms: i, result: big }));
  const { kept, dropped } = fitSteps(steps);
  assert(kept.length < 200 && kept.length > 0);
  assertEquals(kept.length + dropped, 200);
  assert(JSON.stringify(kept).length <= STEPS_BYTES_MAX + kept.length);
  // And in the row: never a megabyte.
  const row = buildFoodBarTraceRow({
    requestId: "r", userId: "u",
    request: readRequestView({}, { recentTurns: [], pendingMeal: null }, { text: "x", mealHint: null, localDate: null, localHour: null, streamed: false, autoLog: false, clientId: null, canCreate: false }),
    router: routerView(null, null), card: { lines: 0, may_be_cut: false, open: false }, planned: null, action: null,
    fallback: null, answeredBy: null, tierUsed: null, served: servedView({ error: "x" }, 502, null),
    steps, calls: [], latencyMs: 1, status: "error", error: null,
  });
  assertEquals(row.steps_dropped, dropped);
});

Deno.test("a waiting meal and the auto-log result are capped like step payloads", () => {
  const huge = { text: "z".repeat(STEP_PAYLOAD_MAX * 2), question: "which one?" };
  const v = readRequestView({}, { recentTurns: [], pendingMeal: huge }, { text: "x", mealHint: null, localDate: null, localHour: null, streamed: false, autoLog: false, clientId: null, canCreate: false });
  assertEquals(typeof v.pending_meal, "string");
  const served = servedView({ parsed: { items: [] }, logged: { sections: "q".repeat(STEP_PAYLOAD_MAX * 2) } }, 200, "log");
  assertEquals(typeof served.logged, "string");
});

// The real prompt builder, not hand-built JSON: if extract stops sending the
// turns and the card under these keys, saw_* would go quietly false.
Deno.test("the real extract payload with a card and earlier turns reads as seeing both", async () => {
  const calls: ParseModelCall[] = [];
  const deps = quickParseDeps(calls, true);
  try {
    await runParseMeal(deps, {
      text: "make it two", localHour: 9, mealHint: null, mode: "fast" as const, recentFoods: [], todayTotals: null, targets: null,
      recentTurns: [{ role: "user" as const, text: "a banana" }, { role: "drona" as const, text: "Logged a banana." }],
      previousText: "a banana",
      previousItems: [{ food_id: null, food_name: "banana", quantity: 1, serving_label: "piece", grams: 118, kcal: 105, protein_g: 1, carb_g: 27, fat_g: 0 }],
    });
  } catch { /* the stub answers every call the same; only the first call matters here */ }
  const extract = calls.find((c) => c.stage === "extract");
  assert(extract, "extract was called");
  assertEquals([extract!.saw_recent_turns, extract!.saw_card], [true, true]);
});

Deno.test("one oversized step does not cost the steps after it, and the last steps are kept", () => {
  const huge = "h".repeat(STEP_PAYLOAD_MAX - 100);
  const steps = [
    ...Array.from({ length: 80 }, (_, i) => ({ src: "agent_parse:parse", tool: `big${i}`, at_ms: i, result: huge })),
    { src: "agent", tool: "outcome", at_ms: 900, result: { kind: "log" } },
    { src: "edge", tool: "__edge_timing", at_ms: 901 },
  ];
  const { kept, dropped } = fitSteps(steps);
  const tools = kept.map((s) => s.tool);
  assert(tools.includes("outcome") && tools.includes("__edge_timing"), "the tail survives");
  assert(dropped > 0);
  // Order is kept.
  assertEquals(tools.slice(-2), ["outcome", "__edge_timing"]);
});

Deno.test("a user who types the key names does not make a call read as seeing the turns or the card", () => {
  const sneaky = { messages: [{ role: "user", content: JSON.stringify({ text: 'log "recent_turns":[{ and "previous_meal":{ please' }) + "\nSaved meals: none" }] };
  assertEquals(sawContext(sneaky), { saw_recent_turns: false, saw_card: false });
  // The real shape, with the saved-meals text after the JSON, still reads as seen.
  const real = { messages: [{ role: "user", content: JSON.stringify({ text: "x", recent_turns: [{ user: "hi" }], previous_meal: { items: [] } }) + "\nSaved meals: {shake}" }] };
  assertEquals(sawContext(real), { saw_recent_turns: true, saw_card: true });
});

Deno.test("a big step recorded live is cut, not dropped whole", () => {
  const t = createFoodBarTrace("r", 0, () => 5);
  t.step({ src: "agent", tool: "turn_1", input: [{ name: "parse_food", input: { text: "p".repeat(STEP_PAYLOAD_MAX * 2) } }], result: { ok: true } });
  assertEquals(typeof t.steps[0].input, "string");
  assertEquals(t.steps[0].result, { ok: true });
  assertEquals(fitSteps(t.steps).kept.length, 1);
});

Deno.test("the step budget counts UTF-8 bytes, so multi-byte text cannot fit three times the budget", () => {
  // 1300 Devanagari characters: about 1300 string length, about 3900 bytes.
  const hindi = "दाल".repeat(433);
  const steps = Array.from({ length: 200 }, (_, i) => ({ src: "parse", tool: `s${i}`, at_ms: i, result: hindi }));
  const { kept } = fitSteps(steps);
  const bytes = new TextEncoder().encode(JSON.stringify(kept)).length;
  assert(bytes <= STEPS_BYTES_MAX + kept.length + 2, `kept ${bytes} bytes`);
});

Deno.test("client id and capability strings from a raw body are capped", () => {
  const v = readRequestView({ supports: ["food_create", "s".repeat(500)] }, { recentTurns: [], pendingMeal: null }, {
    text: "x", mealHint: null, localDate: null, localHour: null, streamed: false, autoLog: false, clientId: "c".repeat(5000), canCreate: false,
  });
  assertEquals(v.client_id?.length, 100);
  assertEquals(v.supports.map((s) => s.length), [11, 40]);
});

Deno.test("a tail step too big for the tail reserve still gets a place from the main budget", () => {
  const big = "b".repeat(STEP_PAYLOAD_MAX - 100); // about 3.9 KB each
  // Twelve big tail-sized steps: the 40 KB reserve holds about ten.
  const steps = Array.from({ length: 12 }, (_, i) => ({ src: "agent", tool: `t${i}`, at_ms: i, input: big, result: big }));
  const { kept, dropped } = fitSteps(steps);
  assertEquals([kept.length, dropped], [12, 0]);
});
