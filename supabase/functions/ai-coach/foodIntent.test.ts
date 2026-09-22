// Run with: deno test --allow-all supabase/functions/ai-coach/foodIntent.test.ts
//
// The ladder is the point of this module, so the tests are mostly about what
// happens when a rung is missing or wrong. Nothing here calls the real Jev API:
// every step is stubbed, because what we are pinning is OUR routing, not
// TypeSafe's accuracy. Their accuracy is an eval question, measured on real
// cases against a real key, and it belongs in the harness rather than in a unit
// test that would then fail whenever their service hiccups.

import { assertEquals } from "jsr:@std/assert@1";
import {
  type FoodIntent,
  type FoodIntentDeps,
  JEV_INTENT_FLOOR,
  parseFoodIntentMode,
  routeFoodIntent,
  NO_SAVED_MATCH,
  SAVED_MATCH_FLOOR,
  type SavedMealSummary,
  shouldRouteFoodIntent,
  CREATE_ACTION_FLOOR,
  decideFoodAction,
  STEPS_ACTION_FLOOR,
  wantsFoodAgent,
} from "./foodIntent.ts";
import { JEV_ENDPOINT, type JevDeps } from "./jev.ts";

// ── Stubs ───────────────────────────────────────────────────────────────────

/** A fetch that answers as Jev would, with the choice and confidence we name. */
function jevFetch(choice: string, confidence: number, calls?: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls?.push(String(url));
    const other = 1 - confidence;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          intent: {
            type: "choice",
            choice,
            probabilities: { log: choice === "log" ? confidence : other, create: choice === "create" ? confidence : other },
            confidence,
          },
        },
        usage: { input_tokens: 40, output_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

/** A fetch that fails with a status, counting attempts. */
function failingFetch(status: number, attempts: { n: number }): typeof fetch {
  return (async () => {
    attempts.n++;
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
}

function jevDeps(fetchFn: typeof fetch): JevDeps {
  return { apiKey: "test-key", timeoutMs: 2000, fetchFn };
}

function deps(over: Partial<FoodIntentDeps> = {}): FoodIntentDeps {
  return { ...over };
}

// ── Step 1: Jev decides ─────────────────────────────────────────────────────

Deno.test("a confident Jev answer is the decision", async () => {
  const d = await routeFoodIntent("save my protein shake for next time", deps({
    jev: jevDeps(jevFetch("create", 0.93)),
  }));
  assertEquals(d.intent, "create");
  assertEquals(d.source, "jev");
  assertEquals(d.confidence, 0.93);
});

Deno.test("the state goes to the documented endpoint", async () => {
  const calls: string[] = [];
  await routeFoodIntent("two eggs and toast", deps({ jev: jevDeps(jevFetch("log", 0.9, calls)) }));
  assertEquals(calls, [JEV_ENDPOINT]);
});

// ── Step 1 -> 2: Jev is unsure, so it does not get to decide ────────────────

// The confidence numbers below are DELIBERATELY absolute rather than derived
// from JEV_INTENT_FLOOR. A test written as `FLOOR - 0.05` moves with the
// constant and so cannot notice the constant being wrong: dropping the floor to
// 0, which trusts every answer Jev ever returns, left the whole suite green.
// These pin the behaviour we actually want at real confidence values.
Deno.test("a barely-better-than-a-coin-flip answer is not trusted", async () => {
  const seen: string[] = [];
  const d = await routeFoodIntent("chicken roll 450", deps({
    // Jev says create, but at 0.3 it is telling us it does not really know.
    jev: jevDeps(jevFetch("create", 0.3)),
    classify: async (t) => { seen.push(t); return "log"; },
  }));
  assertEquals(d.intent, "log");
  assertEquals(d.source, "model");
  assertEquals(d.confidence, null);
  assertEquals(seen.length, 1);
});

Deno.test("a clearly confident answer IS trusted", async () => {
  const d = await routeFoodIntent("save my protein shake", deps({
    jev: jevDeps(jevFetch("create", 0.95)),
    classify: async () => "log",
  }));
  assertEquals(d.source, "jev");
  assertEquals(d.intent, "create");
});

Deno.test("the floor stays in a defensible band", () => {
  // The band is the measured clean window from scripts/food-intent/probe.ts:
  // nothing wrong scored above 25%, nothing right scored below 49%. A floor
  // outside it either trusts a known-bad answer or rejects a known-good one.
  // Moving it is a real decision backed by a fresh probe run, not a one
  // character edit.
  assertEquals(JEV_INTENT_FLOOR > 0.25, true);
  assertEquals(JEV_INTENT_FLOOR < 0.49, true);
});

Deno.test("exactly at the floor counts as confident", async () => {
  const d = await routeFoodIntent("save this", deps({
    jev: jevDeps(jevFetch("create", JEV_INTENT_FLOOR)),
    classify: async () => "log",
  }));
  assertEquals(d.source, "jev");
  assertEquals(d.intent, "create");
});

// ── Step 1 -> 2: Jev is unavailable ─────────────────────────────────────────

Deno.test("no API key skips Jev entirely and costs no call", async () => {
  const calls: string[] = [];
  const d = await routeFoodIntent("save my shake", deps({
    jev: { apiKey: "", timeoutMs: 2000, fetchFn: jevFetch("create", 0.99, calls) },
    classify: async () => "create",
  }));
  assertEquals(d.source, "model");
  assertEquals(calls, []);
});

Deno.test("a rate limit falls through to the model", async () => {
  const attempts = { n: 0 };
  const d = await routeFoodIntent("save my shake", deps({
    jev: jevDeps(failingFetch(429, attempts)),
    classify: async () => "create",
  }));
  assertEquals(d.intent, "create");
  assertEquals(d.source, "model");
  // 429 is retryable, so it is tried twice before we give up on it.
  assertEquals(attempts.n, 2);
});

Deno.test("a bad key is NOT retried, it just falls through", async () => {
  const attempts = { n: 0 };
  const d = await routeFoodIntent("two eggs", deps({
    jev: jevDeps(failingFetch(401, attempts)),
    classify: async () => "log",
  }));
  assertEquals(d.source, "model");
  assertEquals(attempts.n, 1);
});

Deno.test("a thrown fetch never escapes the router", async () => {
  const d = await routeFoodIntent("two eggs", deps({
    jev: jevDeps((() => { throw new Error("socket closed"); }) as unknown as typeof fetch),
    classify: async () => "log",
  }));
  assertEquals(d.intent, "log");
  assertEquals(d.source, "model");
});

Deno.test("a malformed Jev body falls through instead of being trusted", async () => {
  const bad = (async () =>
    new Response(JSON.stringify({ model: "jev-1.13.0", answers: { intent: { type: "score", score: 1 } }, usage: {} }), {
      status: 200,
    })) as unknown as typeof fetch;
  const d = await routeFoodIntent("save this", deps({
    jev: jevDeps(bad),
    classify: async () => "create",
  }));
  assertEquals(d.source, "model");
});

Deno.test("an intent name we do not handle is refused, not passed through", async () => {
  // Guards the forward path: when 'improvise' and 'challenge' are added to the
  // criteria, a build where the router knows them but the caller does not must
  // fall through rather than route somewhere that cannot handle it.
  const d = await routeFoodIntent("what should I eat", deps({
    jev: jevDeps(jevFetch("improvise", 0.98)),
    classify: async () => "log",
  }));
  assertEquals(d.source, "model");
  assertEquals(d.intent, "log");
});

// ── Step 3: the floor ───────────────────────────────────────────────────────

Deno.test("with nothing configured at all, it still logs", async () => {
  const d = await routeFoodIntent("two eggs and toast", deps());
  assertEquals(d.intent, "log");
  assertEquals(d.source, "default");
});

Deno.test("a model that cannot decide drops to the default rather than guessing", async () => {
  const d = await routeFoodIntent("hmm", deps({ classify: async () => null }));
  assertEquals(d.intent, "log");
  assertEquals(d.source, "default");
});

Deno.test("a throwing model classifier drops to the default", async () => {
  const d = await routeFoodIntent("two eggs", deps({
    classify: async () => { throw new Error("anthropic 500"); },
  }));
  assertEquals(d.intent, "log");
  assertEquals(d.source, "default");
});

Deno.test("empty text costs nothing and defaults", async () => {
  const calls: string[] = [];
  let classified = 0;
  const d = await routeFoodIntent("   ", deps({
    jev: jevDeps(jevFetch("create", 0.99, calls)),
    classify: async () => { classified++; return "create"; },
  }));
  assertEquals(d.intent, "log");
  assertEquals(d.source, "default");
  assertEquals(calls, []);
  assertEquals(classified, 0);
});

// ── State hygiene ───────────────────────────────────────────────────────────

Deno.test("a very long message is trimmed before it is sent", async () => {
  let sentLen = 0;
  const capture = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sentLen = String(body.state.message).length;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { intent: { type: "choice", choice: "log", probabilities: { log: 1, create: 0 }, confidence: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await routeFoodIntent("x".repeat(5000), deps({ jev: jevDeps(capture) }));
  // Trimmed, and far short of what was typed. The exact cap is an
  // implementation detail; that it is bounded is not.
  assertEquals(sentLen < 1500, true);
});

Deno.test("the whole ladder is exercised in order: jev, then model, then default", async () => {
  const order: string[] = [];
  const attempts = { n: 0 };
  const d = await routeFoodIntent("save my shake", {
    jev: jevDeps(failingFetch(529, attempts)),
    classify: async () => { order.push("model"); return null; },
    log: (m) => { if (m.includes("jev")) order.unshift("jev"); },
  });
  assertEquals(order[0], "jev");
  assertEquals(order.includes("model"), true);
  assertEquals(d.source, "default");
});

// A compile-time reminder that the union is what the criteria advertise. If a
// new intent is added to FoodIntent without a rubric, this stops being valid.
const _exhaustive: Record<FoodIntent, true> = { log: true, create: true, other: true, steps: true };
void _exhaustive;

// ── The gate: should we even ask? ───────────────────────────────────────────
// These live here rather than in index.ts because index.ts cannot be unit
// tested (Deno globals, npm: imports), and "do not spend a call on a correction"
// is real behaviour, not plumbing.

Deno.test("mode off asks nothing", () => {
  assertEquals(shouldRouteFoodIntent("off", false), false);
  assertEquals(shouldRouteFoodIntent("off", true), false);
});

Deno.test("a correction turn is never routed, in any live mode", () => {
  // A parsed meal is already on screen and the user said "no, the other one".
  // That is editing. It is neither logging nor creating, so both answers are
  // wrong and asking spends a call to learn nothing.
  assertEquals(shouldRouteFoodIntent("shadow", true), false);
  assertEquals(shouldRouteFoodIntent("on", true), false);
});

Deno.test("a first-shot message is routed in shadow and on", () => {
  assertEquals(shouldRouteFoodIntent("shadow", false), true);
  assertEquals(shouldRouteFoodIntent("on", false), true);
});

Deno.test("mode parsing accepts the three words and nothing else", () => {
  assertEquals(parseFoodIntentMode("off"), "off");
  assertEquals(parseFoodIntentMode("on"), "on");
  assertEquals(parseFoodIntentMode("shadow"), "shadow");
  assertEquals(parseFoodIntentMode("  ON  "), "on");
  assertEquals(parseFoodIntentMode("On"), "on");
});

Deno.test("an unrecognised mode falls to shadow, never to on", () => {
  // The direction matters more than the default. A typo in a secret must not be
  // the thing that starts diverting people's meals into an unbuilt path.
  assertEquals(parseFoodIntentMode(undefined), "shadow");
  assertEquals(parseFoodIntentMode(""), "shadow");
  assertEquals(parseFoodIntentMode("enabled"), "shadow");
  assertEquals(parseFoodIntentMode("true"), "shadow");
  assertEquals(parseFoodIntentMode("1"), "shadow");
});

// ── The saved-meal match ────────────────────────────────────────────────────
// Getting this wrong is worse than getting the intent wrong: a bad intent shows
// a card you dismiss, a bad match logs the wrong food under a name you trust.
// So these are mostly about REFUSING a match, not making one.

/** A Jev response carrying both answers. */
function bothFetch(
  intent: string, intentConf: number,
  saved: string, savedConf: number,
  captured?: { body?: string },
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (captured) captured.body = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          intent: {
            type: "choice", choice: intent, confidence: intentConf,
            probabilities: { log: 0.5, create: 0.5 },
          },
          saved: {
            type: "choice", choice: saved, confidence: savedConf,
            probabilities: { [saved]: savedConf },
          },
        },
        usage: { input_tokens: 90, output_tokens: 12 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

const SAVED: SavedMealSummary[] = [
  { id: "id-dosa", name: "Dosa", kcal: 600, item_count: 1 },
  { id: "id-bowl", name: "Breakfast bowl", kcal: 520, item_count: 3 },
];

Deno.test("a confident saved match comes back with its row id", async () => {
  const d = await routeFoodIntent("had my breakfast bowl", {
    jev: jevDeps(bothFetch("log", 0.99, "Breakfast bowl", 0.95)),
    savedMeals: SAVED,
  });
  assertEquals(d.savedMatch?.id, "id-bowl");
  assertEquals(d.savedMatch?.name, "Breakfast bowl");
  assertEquals(d.intent, "log");
});

Deno.test("a match below the floor is ignored, not downgraded", async () => {
  // Wrong here means logging the wrong food under a name the user recognises,
  // so an unsure match is worth nothing and must not leak through.
  const d = await routeFoodIntent("some kind of bowl", {
    jev: jevDeps(bothFetch("log", 0.99, "Breakfast bowl", SAVED_MATCH_FLOOR - 0.01)),
    savedMeals: SAVED,
  });
  assertEquals(d.savedMatch, null);
  assertEquals(d.intent, "log");
});

Deno.test("the no-match option never becomes a match", async () => {
  const d = await routeFoodIntent("two eggs and toast", {
    jev: jevDeps(bothFetch("log", 0.99, NO_SAVED_MATCH, 1.0)),
    savedMeals: SAVED,
  });
  assertEquals(d.savedMatch, null);
});

Deno.test("an option name Jev invented is refused", async () => {
  // Typed output guarantees the shape, not that the value is one we offered.
  const d = await routeFoodIntent("had a thing", {
    jev: jevDeps(bothFetch("log", 0.99, "Dinner bowl", 0.99)),
    savedMeals: SAVED,
  });
  assertEquals(d.savedMatch, null);
});

Deno.test("no saved meals means the question is never asked", async () => {
  const cap: { body?: string } = {};
  const d = await routeFoodIntent("two eggs", {
    jev: jevDeps(bothFetch("log", 0.99, NO_SAVED_MATCH, 1, cap)),
    savedMeals: [],
  });
  assertEquals(d.savedMatch, null);
  const sent = JSON.parse(cap.body ?? "{}");
  assertEquals(Object.keys(sent.questions), ["intent"]);
});

Deno.test("with saved meals, both questions ride ONE call", async () => {
  // The whole reason this is cheap: questions run in parallel against one state
  // and the state is charged once. Two calls would pay for the message twice.
  const cap: { body?: string } = {};
  await routeFoodIntent("had my dosa", {
    jev: jevDeps(bothFetch("log", 0.99, "Dosa", 0.99, cap)),
    savedMeals: SAVED,
  });
  const sent = JSON.parse(cap.body ?? "{}");
  assertEquals(Object.keys(sent.questions).sort(), ["intent", "saved"]);
  // The no-match option must always be offered, or the model is forced to name
  // a saved meal for food that is not one.
  assertEquals(NO_SAVED_MATCH in sent.questions.saved.criteria, true);
});

Deno.test("duplicate saved names stay one-to-one", async () => {
  const cap: { body?: string } = {};
  const dupes: SavedMealSummary[] = [
    { id: "a", name: "Bowl", kcal: 300 },
    { id: "b", name: "Bowl", kcal: 700 },
  ];
  const d = await routeFoodIntent("bowl", {
    jev: jevDeps(bothFetch("log", 0.99, "Bowl (2)", 0.99, cap)),
    savedMeals: dupes,
  });
  // The second "Bowl" is addressable, and resolves to the SECOND row.
  assertEquals(d.savedMatch?.id, "b");
  const sent = JSON.parse(cap.body ?? "{}");
  assertEquals("Bowl (2)" in sent.questions.saved.criteria, true);
});

Deno.test("the saved match survives the intent falling to the model", async () => {
  // Jev was sure which food it was but not what to do with it. The food answer
  // is still worth keeping.
  const d = await routeFoodIntent("my dosa, save it maybe", {
    jev: jevDeps(bothFetch("create", 0.2, "Dosa", 0.97)),
    savedMeals: SAVED,
    classify: async () => "log",
  });
  assertEquals(d.source, "model");
  assertEquals(d.savedMatch?.id, "id-dosa");
});

Deno.test("the match floor is stricter than the intent floor", () => {
  // Deliberate asymmetry. A wrong intent shows a card you dismiss; a wrong match
  // logs the wrong numbers under a name you recognise, which looks right.
  assertEquals(SAVED_MATCH_FLOOR > JEV_INTENT_FLOOR, true);
});

Deno.test("Jev being down loses the match but never the log", async () => {
  const attempts = { n: 0 };
  const d = await routeFoodIntent("had my dosa", {
    jev: jevDeps(failingFetch(529, attempts)),
    savedMeals: SAVED,
    classify: async () => "log",
  });
  assertEquals(d.savedMatch, null);
  assertEquals(d.intent, "log");
});

// ── Policy: decideFoodAction ─────────────────────────────────────────────────
// The rules that stop a calibrated guess from costing anyone a meal. Each one
// is here because a real probe case walked straight into it.

function dec(intent: "log" | "create" | "other" | "steps", confidence: number | null, source: "jev" | "model" | "default" = "jev") {
  return { intent, confidence, source, note: "", savedMatch: null };
}
const on = { mode: "on" as const, parseFoundFood: true, clientSupportsCreate: true };

Deno.test("policy: shadow and off never act, whatever Jev says", () => {
  for (const mode of ["shadow", "off"] as const) {
    assertEquals(decideFoodAction({ ...on, mode, decision: dec("create", 1) }), "log");
    assertEquals(decideFoodAction({ ...on, mode, decision: dec("other", 1), parseFoundFood: false }), "log");
  }
});

Deno.test("policy: no decision is today's behaviour", () => {
  assertEquals(decideFoodAction({ ...on, decision: null }), "log");
});

Deno.test("policy: a confident create diverts", () => {
  assertEquals(decideFoodAction({ ...on, decision: dec("create", 0.99) }), "create");
});

Deno.test("policy: the measured false create at 64% stays a log", () => {
  // "add my greek yogurt bowl" came back create @ 0.64 when it meant log.
  assertEquals(decideFoodAction({ ...on, decision: dec("create", 0.64) }), "log");
});

Deno.test("policy: create never diverts on the model or default rung", () => {
  // Neither has a calibrated number, so neither may turn a meal into a prompt.
  assertEquals(decideFoodAction({ ...on, decision: dec("create", null, "model") }), "log");
  assertEquals(decideFoodAction({ ...on, decision: dec("create", null, "default") }), "log");
  // The case that matters: a model rung that DOES carry a number. Today it never
  // does, so the null check alone would pass the two lines above and the source
  // check would be dead code nobody noticed was load-bearing. The first time
  // someone maps Claude's "high" to 0.95, this is the only thing standing
  // between a guess and a meal turned into a save prompt.
  assertEquals(decideFoodAction({ ...on, decision: dec("create", 0.95, "model") }), "log");
});

Deno.test("policy: an old client never receives a create", () => {
  // Builds 110 / 107 cannot draw one. Sending it would dead-end the food bar.
  assertEquals(decideFoodAction({ ...on, clientSupportsCreate: false, decision: dec("create", 1) }), "log");
});

Deno.test("policy: 'other' replies only when the parse found no food", () => {
  assertEquals(decideFoodAction({ ...on, parseFoundFood: false, decision: dec("other", 1) }), "reply");
});

Deno.test("policy: the parse vetoes a wrong 'other', so no meal is lost", () => {
  // "lunch today was around 700 calories" came back other @ 0.76 when it was a
  // meal. If the parse found food, it is a log, full stop.
  assertEquals(decideFoodAction({ ...on, parseFoundFood: true, decision: dec("other", 0.76) }), "log");
  assertEquals(decideFoodAction({ ...on, parseFoundFood: true, decision: dec("other", 1) }), "log");
});

Deno.test("policy: 'reply' needs no client capability", () => {
  // It rides the existing decline channel, which every build already renders.
  assertEquals(
    decideFoodAction({ ...on, clientSupportsCreate: false, parseFoundFood: false, decision: dec("other", 1) }),
    "reply",
  );
});

Deno.test("policy: the create bar sits above the intent floor", () => {
  assertEquals(CREATE_ACTION_FLOOR > JEV_INTENT_FLOOR, true);
  // And above the measured false positive, or it catches nothing.
  assertEquals(CREATE_ACTION_FLOOR > 0.64, true);
});

// ── Policy: the steps label and the food agent ──────────────────────────────

Deno.test("steps: a confident Jev hands the message to the agent", () => {
  assertEquals(decideFoodAction({ ...on, decision: dec("steps", 0.95) }), "agent");
  assertEquals(wantsFoodAgent(dec("steps", 0.95), true), true);
});

Deno.test("steps: an old build that cannot draw a save card never gets the agent", () => {
  assertEquals(decideFoodAction({ ...on, decision: dec("steps", 0.99), clientSupportsCreate: false }), "log");
  assertEquals(wantsFoodAgent(dec("steps", 0.99), false), false);
});

Deno.test("steps: only Jev may spend the agent, never the model rung", () => {
  assertEquals(wantsFoodAgent(dec("steps", 0.99, "model"), true), false);
  assertEquals(wantsFoodAgent(dec("steps", null, "model"), true), false);
});

Deno.test("steps: the floor is 0.6 and unsure steps fall to log or reply", () => {
  assertEquals(STEPS_ACTION_FLOOR, 0.6);
  assertEquals(wantsFoodAgent(dec("steps", 0.6), true), true);
  assertEquals(wantsFoodAgent(dec("steps", 0.59), true), false);
  // A question about earlier food came back as steps at 49%: no food in it,
  // so it gets a spoken answer, not a decline.
  assertEquals(decideFoodAction({ ...on, decision: dec("steps", 0.49), parseFoundFood: false }), "reply");
  assertEquals(decideFoodAction({ ...on, decision: dec("steps", 0.49), parseFoundFood: true }), "log");
});
