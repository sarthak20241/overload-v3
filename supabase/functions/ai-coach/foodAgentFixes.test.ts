// Run with: deno test --allow-all supabase/functions/ai-coach/foodAgentFixes.test.ts
//
// Fixes to the later-mode food agent (FOOD_AGENT_LATER), from the food box
// eval's diagnosed failures. What these pin:
//   1. a doubt about a line is fixed in the same turn; a line the user typed
//      (origin user_typed) changes only when their message gives a number
//   2. the save check: an earlier ask never carried out still counts, a save
//      that already exists is refused, a reply beside a save card reaches the user
//   3. a label line counted in pieces weighs pieces x the label's piece, and
//      no card change may leave a 0 kcal line for a food that has calories
//   4. use_label prices the amount the user stated
//   5. build_recipe parts come from the user's own words

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  CARD_NOTE_LATER,
  cardLinesWithIds,
  type FoodAgentDeps,
  givesNumber,
  planCardChanges,
  runFoodAgent,
  USER_TYPED_MARK,
} from "./foodAgent.ts";
import { type CardLine, cardOriginsOf } from "./foodContext.ts";
import type { ParseMealResult, ParsedItem } from "./parseMeal.ts";

type Use = { name: string; input: Record<string, unknown> };

function scripted(script: Use[][], bodies: Record<string, unknown>[] = []): FoodAgentDeps["callModel"] {
  let n = 0;
  return async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const uses = script[Math.min(n, script.length - 1)];
    n++;
    return {
      ok: true,
      data: {
        usage: { input_tokens: 100, output_tokens: 20 },
        content: uses.map((u, i) => ({ type: "tool_use", id: `t${n}_${i}`, name: u.name, input: u.input })),
      },
    };
  };
}

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };

function item(food_name: string, kcal: number, more: Partial<ParsedItem> = {}): ParsedItem {
  return {
    food_id: null, food_name, quantity: 1, serving_label: "serving", grams: 100, kcal,
    protein_g: 5, carb_g: 10, fat_g: 2, fiber_g: null, source: "catalog", assumption: null, confidence: "medium",
    ...more,
  };
}

function result(items: ParsedItem[]): ParseMealResult {
  return {
    parsed: { meal_type: "dinner", items, drona_line: "", corrects_previous: true },
    declined: null, usage: { ...USAGE, input_tokens: 50 }, tool_calls: ["extract_meal"], steps: [], iterations: 1, tier: "precise",
  };
}

const CARD: CardLine[] = [
  { food_name: "Roti", quantity: 2, serving_label: "piece", grams: 80, kcal: 240, protein_g: 7, carb_g: 36, fat_g: 7.4, source: "catalog", meal_type: "dinner" },
  { food_name: "Dal", quantity: 1, serving_label: "katori", grams: 150, kcal: 150, protein_g: 7, carb_g: 20, fat_g: 4, source: "catalog", meal_type: "dinner" },
  // The user typed this one's calories.
  { food_name: "Protein bar", quantity: 1, serving_label: "bar", grams: 60, kcal: 210, protein_g: 20, carb_g: 20, fat_g: 7, source: "manual", origin: "user_typed", meal_type: "dinner" },
];

function deps(callModel: FoodAgentDeps["callModel"], log: string[] = []): FoodAgentDeps {
  return {
    model: "sonnet",
    callModel,
    readDiary: async () => ({ meals: [] }),
    savedMeals: async () => [],
    parseFood: async (t) => {
      log.push(`parse:${t}`);
      return result([item(t, 155, { source: "estimate" })]);
    },
    editLine: async (i, change) => {
      log.push(`edit:${i}:${change}`);
      return result([item(CARD[i].food_name, 360)]);
    },
  };
}

const LATER = { text: "x", defaultMeal: "dinner" as const, card: CARD, later: true };

/** The tool results the agent read at the start of turn `n` (1-based). */
function resultsBefore(bodies: Record<string, unknown>[], n: number): string[] {
  const msgs = bodies[n - 1].messages as { content: unknown }[];
  const last = msgs.at(-1)!.content;
  return Array.isArray(last) ? last.map((c) => String((c as { content?: unknown }).content ?? "")) : [];
}

// ── 1. Doubts are fixed in the same turn; the user's own number is asked about ──

Deno.test("cardOriginsOf: each card line's origin as the app sent it, aligned with the card", () => {
  const raw = [
    { food_name: "Roti", origin: "catalog" },
    { food_name: "  " }, // no name: not a card line, so it takes no slot
    { food_name: "Bar", origin: "user_typed", copied_from: "diary" },
    { food_name: "Dal", origin: "made_up", copied_from: "nowhere" },
  ];
  assertEquals(cardOriginsOf(raw), [{ origin: "catalog" }, { origin: "user_typed", copied_from: "diary" }, {}]);
  assertEquals(cardOriginsOf(null), []);
});

Deno.test("cardLinesWithIds: a line the user typed the numbers for says so; others do not", () => {
  const lines = cardLinesWithIds(CARD);
  assert(lines[2].endsWith(`| ${USER_TYPED_MARK}`), lines[2]);
  assertFalse(lines[0].includes(USER_TYPED_MARK));
  // "manual" alone is not proof the user typed it (a copy, a kept line).
  assertFalse(cardLinesWithIds([{ ...CARD[2], origin: undefined }])[0].includes(USER_TYPED_MARK));
  // An old line with the server's own "Your numbers" note is.
  assert(cardLinesWithIds([{ ...CARD[2], origin: undefined, assumption: "Your numbers: 210 kcal" }])[0].includes(USER_TYPED_MARK));
});

Deno.test("CARD_NOTE_LATER: a doubt that does not fit is fixed in the same turn; ok and Add stay", () => {
  assertFalse(CARD_NOTE_LATER.includes("never re-guess"));
  assertFalse(CARD_NOTE_LATER.includes("A question or complaint about the card with nothing to change is reply"));
  assert(CARD_NOTE_LATER.includes("fix it in the SAME turn with edit_line"));
  assert(CARD_NOTE_LATER.includes("Never wait for another message"));
  assert(CARD_NOTE_LATER.includes(USER_TYPED_MARK));
  assert(CARD_NOTE_LATER.includes("A bare ok or thanks accepts the card as it is."));
  assert(CARD_NOTE_LATER.includes("Add puts it in"));
  assertFalse(CARD_NOTE_LATER.includes("—"));
});

Deno.test("givesNumber: digits and number words", () => {
  for (const t of ["it was 150", "make it two", "half of that", "1/2"]) assert(givesNumber(t), t);
  for (const t of ["is this right?", "that bar seems high"]) assertFalse(givesNumber(t), t);
});

Deno.test("planCardChanges: the user's own number is not changed without a new number", () => {
  const edit = (line_id: string, extra: Record<string, unknown> = {}) => [{ name: "edit_line", input: { line_id, change: "seems high", ...extra } }];
  const refused = planCardChanges(CARD, edit("L3"), false, false, "that bar seems high");
  assertFalse(refused.ok);
  if (!refused.ok) assert(refused.error.includes(USER_TYPED_MARK) && refused.error.includes("ask once"), refused.error);
  // A new number in the message: the change goes ahead.
  assert(planCardChanges(CARD, edit("L3"), false, false, "the bar was 180 cal").ok);
  // Any other line: the doubt is the change.
  assert(planCardChanges(CARD, edit("L1"), false, false, "the roti seems high").ok);
  // A label keeps the user's number and fills in the rest.
  assert(planCardChanges(CARD, edit("L3", { use_label: true }), false, false, "check the label").ok);
  // No message given (old callers): no check.
  assert(planCardChanges(CARD, edit("L3")).ok);
});

Deno.test("runFoodAgent: an edit of the user's own number is sent back, and the agent replies", async () => {
  const bodies: Record<string, unknown>[] = [];
  const log: string[] = [];
  const out = await runFoodAgent({ ...LATER, text: "is the bar really that much?" }, deps(scripted([
    [{ name: "edit_line", input: { line_id: "L3", change: "the user doubts it" } }],
    [{ name: "reply", input: { text: "That 210 is the number you typed. Want me to change it?" } }],
  ], bodies), log));
  assertEquals(out.kind, "reply");
  assertEquals(log.filter((l) => l.startsWith("edit:")), []);
  assert(resultsBefore(bodies, 2)[0].includes(USER_TYPED_MARK));
});
