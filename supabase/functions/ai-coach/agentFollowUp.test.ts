// Run with: deno test --allow-all supabase/functions/ai-coach/agentFollowUp.test.ts
//
// A question the food agent asks is answered to the agent. Live, 2026-10-18:
// "same oatmeal as yesterday" went to the agent, which read yesterday's diary
// and asked which meal. The answer went to the parse, which cannot see the
// diary, so it guessed the amounts again instead of copying the logged lines.
// Nothing here calls Jev or a model.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { openingText } from "./foodAgent.ts";
import { type PendingFoodMeal, readFoodContext } from "./foodContext.ts";
import {
  agentAsked,
  continuesPendingMeal,
  decideFoodAction,
  type FoodIntentDecision,
  routeFoodIntent,
  wantsFoodAgent,
  withPendingMeal,
} from "./foodIntent.ts";
import type { ParseMealDeps } from "./parseMeal.ts";

const oats: PendingFoodMeal = {
  status: "awaiting_clarification",
  text: "same oatmeal as yesterday",
  question: "Yesterday had oats at breakfast and at dinner. Which one?",
};
const fromAgent: PendingFoodMeal = { ...oats, origin: "agent" };

function jevAnswers(answers: Record<string, unknown>): ParseMealDeps["fetchFn"] {
  return (async () => Response.json({ model: "jev-test", answers, usage: {} })) as typeof fetch;
}
const choice = (c: string, p: number) => ({ type: "choice", choice: c, confidence: p, probabilities: { [c]: p } });
const route = (pending: PendingFoodMeal, proceed: number) =>
  routeFoodIntent("the breakfast one", {
    jev: {
      apiKey: "k",
      timeoutMs: 1000,
      fetchFn: jevAnswers({ intent: choice("log", 0.6), has_food: { type: "noul", noul: 0.4 }, pending: choice("proceed", proceed) }),
    },
  }, readFoodContext([], pending));

Deno.test("the app's copy of the meal keeps who asked; anything else is dropped", () => {
  assertEquals(readFoodContext([], fromAgent).pendingMeal?.origin, "agent");
  assertEquals(readFoodContext([], oats).pendingMeal?.origin, undefined);
  assertEquals(readFoodContext([], { ...oats, origin: "parse" } as unknown as PendingFoodMeal).pendingMeal?.origin, undefined);
});

Deno.test("the agent's question is marked as the agent's, and stays marked while it waits", () => {
  const asked = withPendingMeal(
    { message: oats.question },
    { decision: { intent: "steps", source: "jev", confidence: 0.9, note: "t", savedMatch: null, hasFood: 0.9 }, incoming: null, text: oats.text, fromAgent: true },
  );
  assertEquals(asked?.pending_meal?.origin, "agent");
  // The parse asked: no mark.
  const parse = withPendingMeal(
    { message: oats.question },
    { decision: { intent: "log", source: "jev", confidence: 0.9, note: "t", savedMatch: null, hasFood: 0.9 }, incoming: null, text: oats.text },
  );
  assertEquals(parse?.pending_meal?.origin, undefined);
});

Deno.test("the failure this prevents: the answer to the agent's question went to the parse", async () => {
  const d = await route(fromAgent, 0.6);
  assertEquals([d.intent, d.resumeAgent], ["steps", true]);
  assert(wantsFoodAgent(d, true), "the answer must go back to the agent");
  // An old app has no create card, so it cannot take the agent's work.
  assertEquals(wantsFoodAgent(d, false), false);
  // The agent asks again: the meal keeps waiting, joined with the answer, still the agent's.
  const again = withPendingMeal({ message: "Which bowl size?" }, { decision: d, incoming: fromAgent, text: "the breakfast one", fromAgent: true });
  assertEquals(again?.pending_meal?.origin, "agent");
  assert(again!.pending_meal!.text.endsWith("the breakfast one"));
});

Deno.test("whoever asks the next question owns its answer", async () => {
  const d = await route(fromAgent, 0.6);
  // The agent could not finish and the parse asked instead: the parse's answer.
  const parseAsked = withPendingMeal({ message: "How many grams of oats?" }, { decision: d, incoming: fromAgent, text: "the breakfast one" });
  assertEquals(parseAsked?.pending_meal?.origin, undefined);
  // A turn that does not touch the meal keeps it, and who asked, as it was.
  const aside = withPendingMeal(
    { message: "You have 40 g protein left." },
    { decision: { intent: "other", source: "jev", confidence: 0.95, note: "t", savedMatch: null, pendingAction: "unrelated", hasFood: 0 }, incoming: fromAgent, text: "protein left?" },
  );
  assertEquals(aside?.pending_meal, fromAgent);
});

Deno.test("an app that cannot take the agent's work finishes the meal with the parse", async () => {
  const d = await route(fromAgent, 0.6);
  assert(continuesPendingMeal(d), "the parse beside the agent must see the waiting meal");
  assertEquals(decideFoodAction({ decision: d, mode: "on", parseFoundFood: false, clientSupportsCreate: false }), "log");
  assertEquals(decideFoodAction({ decision: d, mode: "on", parseFoundFood: false, clientSupportsCreate: true }), "agent");
});

Deno.test("only a reply the agent wrote is the agent's question; a failed turn is not", () => {
  assertEquals(agentAsked({ kind: "reply" }), true);
  assertEquals(agentAsked({ kind: "failed" }), false);
  assertEquals(agentAsked(undefined), false);
});

Deno.test("a question the parse asked still goes to the parse", async () => {
  const d = await route(oats, 0.6);
  assertEquals([d.intent, d.resumeAgent ?? false], ["continue", false]);
  assertEquals(wantsFoodAgent(d, true), false);
});

Deno.test("an answer that is not an answer is not sent to the agent", async () => {
  const d = await routeFoodIntent("how much protein left?", {
    jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevAnswers({ intent: choice("other", 0.95), has_food: { type: "noul", noul: 0.02 }, pending: choice("new_meal", 0.9) }) },
  }, readFoodContext([], fromAgent));
  assertEquals(d.resumeAgent ?? false, false);
  assertEquals(wantsFoodAgent(d as FoodIntentDecision, true), false);
});

Deno.test("the agent reads the answer against its own question", () => {
  const text = openingText({ text: "the breakfast one", answering: { text: oats.text, question: oats.question } }, "Today is Sunday 2026-10-18.");
  assert(text.includes(oats.question) && text.includes(oats.text) && text.endsWith("the breakfast one"), text);
  assert(/read the diary again/.test(text), text);
  // A fresh message is sent as before.
  assertEquals(openingText({ text: "same oatmeal as yesterday" }, "Today is Sunday 2026-10-18."), "(Today is Sunday 2026-10-18.)\nsame oatmeal as yesterday");
});
