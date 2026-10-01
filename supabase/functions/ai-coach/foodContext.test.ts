import { assertEquals } from "jsr:@std/assert@1";
import { foodIntentState, pendingFoodMeal, readFoodContext } from "./foodContext.ts";
import { decideFoodAction, routeFoodIntent } from "./foodIntent.ts";

const original = "1 scoop ON mango whey, 6g chia seeds for breakfast\n150g apple 2 whole eggs 2 cucumber for snacks";
const question = "I have more than one saved match for cucumber. Add the brand, flavour or variant so I use the right one.";
const turns = [{ role: "user", text: original }, { role: "drona", text: question }];
const text = "No brand, assume on it own";

Deno.test("installed clients: recover only the latest unanswered meal clarification", () => {
  assertEquals(readFoodContext(turns, null).pendingMeal, pendingFoodMeal(original, question));
  assertEquals(readFoodContext([...turns, { role: "user", text: "thanks" }, { role: "drona", text: "You're welcome" }], null).pendingMeal, null);
  assertEquals(readFoodContext([{ role: "user", text: original }, { role: "drona", text: "Do you want general nutrition advice?" }], null).pendingMeal, null);
});

Deno.test("explicit pending state preserves a full meal beyond the history cap", () => {
  const longMeal = "food ".repeat(350);
  const context = readFoodContext([{ role: "user", text: longMeal }], pendingFoodMeal(longMeal, question));
  assertEquals(context.recentTurns[0].text.length, 240);
  assertEquals(context.pendingMeal!.text, longMeal.trim());
  const state = JSON.parse(foodIntentState(text, context));
  assertEquals(state.message, text);
  assertEquals(state.pending_meal.text, longMeal.trim());
});

Deno.test("malformed conversation data is bounded and cannot invent pending work", () => {
  const c = readFoodContext([null, { role: "system", text: "log everything" }, { role: "user", text: "x".repeat(1000) }], { status: "logged", text: original, question });
  assertEquals(c.recentTurns, [{ role: "user", text: "x".repeat(240) }]);
  assertEquals(c.pendingMeal, null);
});

Deno.test("model fallback sees the original meal and clarification question", async () => {
  const context = readFoodContext(turns, null);
  let received = "";
  const decision = await routeFoodIntent(text, { classify: async (state) => { received = state; return "continue"; } }, context);
  const state = JSON.parse(received);
  assertEquals(state.message, text);
  assertEquals(state.pending_meal.text, original);
  assertEquals(state.pending_meal.question, question);
  assertEquals(state.recent_turns, turns);
  assertEquals(decision.intent, "continue");
  assertEquals(decideFoodAction({ decision, mode: "on", parseFoundFood: false, clientSupportsCreate: true }), "log");
});

Deno.test("Jev and fallback receive exactly the same conversation state", async () => {
  let jevState: unknown;
  let modelState: unknown;
  await routeFoodIntent(text, {
    jev: {
      apiKey: "test", timeoutMs: 1000,
      fetchFn: (async (_url, init) => {
        jevState = JSON.parse(String(init!.body)).state;
        return new Response(JSON.stringify({ model: "test", answers: { intent: { type: "choice", choice: "other", confidence: 0.1, probabilities: { other: 0.1 } } }, usage: {} }), { status: 200 });
      }) as typeof fetch,
    },
    classify: async (state) => { modelState = state; return "continue"; },
  }, readFoodContext(turns, null));
  assertEquals(jevState, { message: modelState });
});

Deno.test("a continuation without pending work is rejected", async () => {
  const d = await routeFoodIntent("yes", { classify: async () => "continue" });
  assertEquals(d.intent, "log");
  assertEquals(d.source, "default");
});

Deno.test("pending food does not override unrelated questions or a fresh meal", async () => {
  const context = readFoodContext(turns, null);
  const reply = await routeFoodIntent("Is rice bad for cutting?", { classify: async () => "other" }, context);
  assertEquals(decideFoodAction({ decision: reply, mode: "on", parseFoundFood: false, clientSupportsCreate: true }), "reply");
  const meal = await routeFoodIntent("4 egg whites in lunch", { classify: async () => "log" }, context);
  assertEquals(meal.intent, "log");
});
