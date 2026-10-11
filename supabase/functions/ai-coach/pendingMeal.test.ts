// Run with: deno test --allow-all supabase/functions/ai-coach/pendingMeal.test.ts
//
// A meal waiting on Drona's question must survive until it is logged or the
// user drops it. The thread that drove this, one real user, 2026-10-08:
//
//   "8g cocoa powder, 4g casein"   -> a question; the meal waits
//   "Choose first"                 -> the question again, WITHOUT the meal
//   (an angry message)             -> chat; nothing was waiting any more
//   "any"                          -> chat: "logging a standard casein shake
//                                     for you now". Nothing was logged.
//   "Log kar na bc"                -> parsed alone: "no food here"
//
// The app keeps only what the latest reply carries, so each reply that dropped
// the meal is where it was lost. Nothing here calls Jev or a model.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type PendingFoodMeal, readFoodContext } from "./foodContext.ts";
import {
  claimsAction,
  type FoodIntentDecision,
  HAS_FOOD_FLOOR,
  readReplyResult,
  routeFoodIntent,
  withPendingMeal,
} from "./foodIntent.ts";
import { type ParseMealDeps, runParseMeal } from "./parseMeal.ts";

const casein: PendingFoodMeal = {
  status: "awaiting_clarification",
  text: "8g cocoa powder, 4g casein",
  question: "Which casein was it?",
};
const decision = (d: Partial<FoodIntentDecision>): FoodIntentDecision => ({
  intent: "other", source: "jev", confidence: 0.9, note: "test", savedMatch: null, ...d,
});

// ── The rule ────────────────────────────────────────────────────────────────

Deno.test("the failure this prevents: a chat reply dropped the meal that was waiting", () => {
  const out = withPendingMeal(
    { message: "I hear you, casein options can be frustrating!" },
    { decision: decision({ intent: "other", pendingAction: "unrelated", hasFood: 0.05 }), incoming: casein, text: "ugh, this is so annoying" },
  );
  assertEquals(out?.pending_meal, casein);
});

Deno.test("an answer that still logged nothing joins the meal, and the meal keeps waiting", () => {
  const out = withPendingMeal(
    { message: "Tell me the brand of your casein." },
    { decision: decision({ intent: "continue", pendingAction: "proceed" }), incoming: casein, text: "the plain one" },
  );
  assertEquals(out?.pending_meal?.text, "8g cocoa powder, 4g casein\nUser clarification for this unlogged meal: the plain one");
  assertEquals(out?.pending_meal?.question, "Tell me the brand of your casein.");
});

Deno.test("food that was named and not logged starts waiting; a message with no food does not", () => {
  const vague = { decision: decision({ intent: "log", hasFood: 0.94 }), incoming: null, text: "Veggies" };
  assertEquals(withPendingMeal({ message: "Which veggies, and how much?" }, vague)?.pending_meal, {
    status: "awaiting_clarification", text: "Veggies", question: "Which veggies, and how much?",
  });
  const hi = { decision: decision({ intent: "other", hasFood: 0.01 }), incoming: null, text: "hi" };
  assertEquals(withPendingMeal({ message: "Hey! What did you eat?" }, hi)?.pending_meal, undefined);
  // Exactly at the bar counts as food; just under it does not.
  const at = (p: number) => withPendingMeal({ message: "Which ones?" }, { decision: decision({ intent: "log", hasFood: p }), incoming: null, text: "some fruit" });
  assertEquals(at(HAS_FOOD_FLOOR)?.pending_meal?.text, "some fruit");
  assertEquals(at(HAS_FOOD_FLOOR - 0.01)?.pending_meal, undefined);
});

Deno.test("the user dropping the meal, or a cleared card, leaves nothing waiting", () => {
  const cancel = { decision: decision({ intent: "other", pendingAction: "cancel" }), incoming: casein, text: "never mind" };
  assertEquals(withPendingMeal({ message: "No problem." }, cancel)?.pending_meal, undefined);
  const cleared = { decision: decision({ intent: "log" }), incoming: casein, text: "remove it" };
  assertEquals(withPendingMeal({ message: "Removed it.", cleared: true }, cleared)?.pending_meal, undefined);
});

Deno.test("with the router off, a waiting meal still survives", () => {
  assertEquals(withPendingMeal({ message: "Hi!" }, { decision: null, incoming: casein, text: "hi" })?.pending_meal, casein);
});

// ── The router ──────────────────────────────────────────────────────────────

function jevAnswers(answers: Record<string, unknown>, asked?: string[][]): ParseMealDeps["fetchFn"] {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    asked?.push(Object.keys(JSON.parse(String(init!.body)).questions));
    return Response.json({ model: "jev-test", answers, usage: {} });
  }) as typeof fetch;
}
const choice = (c: string, p: number) => ({ type: "choice", choice: c, confidence: p, probabilities: { [c]: p } });

Deno.test("with a meal waiting, a reply that leaves the choice to Drona finishes it, even unsure", async () => {
  // The real "any" was read as chat by the intent question (other @ 79%).
  const asked: string[][] = [];
  const d = await routeFoodIntent("any", {
    jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevAnswers({ intent: choice("other", 0.79), has_food: { type: "noul", noul: 0.08 }, pending: choice("proceed", 0.3) }, asked) },
  }, readFoodContext([], casein));
  assertEquals([d.intent, d.pendingAction, d.hasFood], ["continue", "proceed", 0.08]);
  assert(asked[0].includes("pending") && asked[0].includes("has_food"));
});

Deno.test("the waiting-meal question is asked only when a meal is waiting", async () => {
  const asked: string[][] = [];
  const d = await routeFoodIntent("any", {
    jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevAnswers({ intent: choice("other", 0.8), has_food: { type: "noul", noul: 0.1 } }, asked) },
  });
  assertEquals(asked[0].includes("pending"), false);
  assertEquals([d.intent, d.pendingAction], ["other", null]);
});

Deno.test("cancel needs to be sure; anything else leaves the meal waiting", async () => {
  const route = (p: unknown) => routeFoodIntent("never mind", {
    jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevAnswers({ intent: choice("other", 0.9), has_food: { type: "noul", noul: 0.05 }, pending: p }) },
  }, readFoodContext([], casein));
  assertEquals((await route(choice("cancel", 0.9))).pendingAction, "cancel");
  assertEquals((await route(choice("cancel", 0.5))).pendingAction, "unrelated");
  const meal = await route(choice("new_meal", 0.99));
  assertEquals([meal.intent, meal.pendingAction], ["other", "unrelated"]);
});

// ── The answer turn always logs ─────────────────────────────────────────────

const EST = { label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null };

Deno.test("the failure this prevents: an answered meal was declined, so the user was asked again", async () => {
  const systems: string[] = [], texts: string[] = [];
  const deps: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      systems.push(JSON.stringify(body.system));
      texts.push(String(body.messages[0].content));
      const input = systems.length === 1
        ? { declined: true, decline_message: "Tell me the brand of your casein.", meal_type_from_text: null, items: [] }
        : {
          declined: false, meal_type_from_text: null, items: [
            { name: "cocoa powder", brand: null, quantity: 8, unit: "g", prep: null, ...EST, est_kcal: 18, est_protein_g: 1.6, est_carb_g: 4.6, est_fat_g: 1.1, est_total_g: 8 },
            { name: "casein", brand: null, quantity: 4, unit: "g", prep: null, assumption: "Took the plain one", ...EST, est_kcal: 15, est_protein_g: 3.2, est_carb_g: 0.2, est_fat_g: 0.1, est_total_g: 4 },
          ],
        };
      return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "estimate_meal", input }] });
    }) as typeof fetch,
  };
  const r = await runParseMeal(deps, {
    text: "Choose first", localHour: 19, mealHint: "snack", mode: "fast", pendingMeal: casein,
    recentFoods: [], todayTotals: null, targets: null,
  });
  assertEquals(r.declined, null);
  assertEquals(r.parsed!.items.map((i) => i.food_name), ["cocoa powder", "casein"]);
  assertEquals(r.parsed!.continued_pending, true);
  // Both calls carry the rule; the retry carries the meal and the answer as one message.
  assert(systems.every((s) => s.includes("never decline it and never ask again")));
  assert(texts[1].includes("8g cocoa powder, 4g casein") && texts[1].includes("User clarification for this unlogged meal: Choose first"));
  assert(r.steps.some((s) => s.tool === "pending_retry"));
});

Deno.test("a second decline stands, so the retry can never loop", async () => {
  let calls = 0;
  const deps: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn: (async () => {
      calls++;
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: "estimate_meal", input: { declined: true, decline_message: "No food here.", meal_type_from_text: null, items: [] } }] });
    }) as typeof fetch,
  };
  const r = await runParseMeal(deps, {
    text: "hmm", localHour: 19, mealHint: null, mode: "fast", pendingMeal: casein,
    recentFoods: [], todayTotals: null, targets: null,
  });
  assertEquals(calls, 2);
  assertEquals(r.declined?.message, "No food here.");
});

// ── The chat reply cannot log, so it may not say it did ─────────────────────

Deno.test("the failure this prevents: the chat reply promised a log it could not make", () => {
  const r = readReplyResult({ ok: true, status: 200, data: { content: [{ type: "text", text: "Got it - logging a standard casein shake for you now." }] } } as never, 1);
  assertEquals(r.followup.error, "unsupported_action_claim");
  assert(!r.reply!.includes("logging"));
});

Deno.test("offers and questions are not claims", () => {
  assertEquals(claimsAction("Tell me what you ate and I'll log it."), false);
  assertEquals(claimsAction("Got it - ON mango whey, 1 scoop - is that what you're logging now?"), false);
  assertEquals(claimsAction("You got it - I'll add a standard veggies option at 50 cal for you."), true);
  assertEquals(claimsAction("I logged veggies and fats, 50 cal to your food diary."), true);
});
