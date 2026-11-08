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
  FOOD_AGENT_SYSTEM_LATER,
  givesNumber,
  labelLineAt,
  lineFromLabel,
  onlyAmount,
  planCardChanges,
  MAX_TURNS_LATER,
  runFoodAgent,
  SAVE_CARD_TAIL,
  saveCardLine,
  savedMealAlready,
  statedAmount,
  toolsForLater,
  unmetSaveAsk,
  USER_TYPED_MARK,
  userAskedToSave,
  zeroKcalLine,
} from "./foodAgent.ts";
import type { SavedMealForParse } from "./savedMeals.ts";
import { partsNotFromUser } from "./recipe.ts";
import { type CardLine, cardOriginsOf } from "./foodContext.ts";
import type { LabelFound, ParseMealResult, ParsedItem } from "./parseMeal.ts";

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

// ── 2. The save check ──────────────────────────────────────────────────────

const ASK = { role: "user" as const, text: "save it as a meal and put it in dinner, I had 50 g of it" };

Deno.test("unmetSaveAsk: an earlier save ask counts until a save card answers it", () => {
  // Drona answered with words, no save card: the ask still stands.
  assertEquals(unmetSaveAsk([ASK, { role: "drona", text: "Paneer keeps the protein up." }]), ASK.text);
  // A reply that says nothing was saved is no save card either.
  assertEquals(unmetSaveAsk([ASK, { role: "drona", text: "Nothing has been saved yet, and My Meals has no paneer dish." }]), ASK.text);
  // A save card's line (the app records its summary as Drona's turn) answers it.
  assertEquals(unmetSaveAsk([ASK, { role: "drona", text: "Paneer, 50 g, 95 cal. Want it in My Meals?" }]), null);
  assertEquals(unmetSaveAsk([ASK, { role: "drona", text: "Tap the card to save it." }]), null);
  // The user says it is saved.
  assertEquals(unmetSaveAsk([ASK, { role: "drona", text: "Here it is." }, { role: "user", text: "ok I saved it" }]), null);
  // No ask, or a negated one.
  assertEquals(unmetSaveAsk([{ role: "user", text: "don't save it" }, { role: "drona", text: "Fine." }]), null);
  assertEquals(unmetSaveAsk(undefined), null);
  assert(userAskedToSave({ text: "did you do it?", recentTurns: [ASK, { role: "drona", text: "Paneer keeps the protein up." }] }));
  assertFalse(userAskedToSave({ text: "did you do it?", recentTurns: [ASK, { role: "drona", text: "Paneer, 95 cal. Want it in My Meals?" }] }));
});

const PANEER: CardLine[] = [
  { food_name: "Milky Mist low fat paneer", quantity: 1, serving_label: "serving", grams: 50, kcal: 95, protein_g: 12.5, carb_g: 2, fat_g: 4, source: "estimate" },
];

Deno.test("an unmet earlier ask: the save goes ahead now, with its section, and the reply leads the save card", async () => {
  const out = await runFoodAgent({
    text: "was that done?", defaultMeal: "snack", card: PANEER, later: true,
    recentTurns: [ASK, { role: "drona", text: "Paneer keeps the protein up." }],
  }, deps(scripted([[
    { name: "save_card_as_meal", input: { name: "Paneer", log_now: true, meal_type: "dinner", summary: "Paneer, 50 g. Want it in My Meals and dinner?" } },
    { name: "reply", input: { text: "No, it was not saved before. Here is the save card, set for dinner." } },
  ]])));
  assertEquals(out.kind, "create");
  if (out.kind !== "create") return;
  assertEquals(out.create.input.meal_type, "dinner");
  assertEquals(out.create.input.log_now, true);
  assertEquals(out.reply, "No, it was not saved before. Here is the save card, set for dinner.");
  assert(String(out.create.input.summary).startsWith("No, it was not saved before."), String(out.create.input.summary));
  assert(String(out.create.input.summary).includes("Want it in My Meals"));
  // The later save tool offers the section; the plain one stays as it was.
  const later = toolsForLater(PANEER).find((t) => t.name === "save_card_as_meal")!;
  assert("meal_type" in (later.input_schema.properties as Record<string, unknown>));
});

Deno.test("a reply beside a save card that claims the save is dropped; the card's own line stays", async () => {
  const out = await runFoodAgent({ text: "save this as a meal", defaultMeal: "snack", card: PANEER, later: true }, deps(scripted([[
    { name: "save_card_as_meal", input: { name: "Paneer", log_now: false, summary: "Paneer, 95 cal. Want it in My Meals?" } },
    { name: "reply", input: { text: "I've saved it for you." } },
  ]])));
  assertEquals(out.kind, "create");
  if (out.kind !== "create") return;
  assertEquals(out.create.input.summary, "Paneer, 95 cal. Want it in My Meals?");
  assertEquals(out.reply, undefined);
});

Deno.test("saveCardLine: the reply first, within the app's 300 characters, still saying what the tap does", () => {
  assertEquals(saveCardLine("Not saved yet.", "Paneer. Want it in My Meals?"), "Not saved yet. Paneer. Want it in My Meals?");
  const long = saveCardLine("x".repeat(290), "Paneer. Want it in My Meals?");
  assert(long.length <= 300 && long.endsWith(SAVE_CARD_TAIL), long);
});

Deno.test("an earlier ask a save card already answered: no second save card, and the agent hears why", async () => {
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent({
    text: "nice, the roti was 3", defaultMeal: "dinner", card: CARD, later: true,
    recentTurns: [{ role: "user", text: "save this as a meal" }, { role: "drona", text: "Dinner, 3 items, 600 cal. Want it in My Meals?" }],
  }, deps(scripted([
    [{ name: "save_card_as_meal", input: { name: "Dinner", log_now: false, summary: "Save it?" } }],
    [{ name: "reply", input: { text: "The save card is above: a tap saves it." } }],
  ], bodies)));
  assertEquals(out.kind, "reply");
  assert(resultsBefore(bodies, 2)[0].includes("already offered"));
});

const SAVED: SavedMealForParse[] = [{
  id: "s1", name: "Milky Mist Low Fat Paneer Sabji", kind: "meal", servings: 1, serving_label: null,
  kcal: 150, protein_g: 11, carb_g: 4, fat_g: 10,
  items: [{ food_id: null, food_name: "Milky Mist Low Fat Paneer Sabji", quantity: 1, serving_unit: "serving", grams: null, kcal: 150, protein_g: 11, carb_g: 4, fat_g: 10, fiber_g: null }],
}];

Deno.test("savedMealAlready: the same name (recipe words in it do not count) and the same lines", () => {
  const food = (name: string, kcal: number) => ({ name: "create_custom_food", input: { name, kcal } });
  assertEquals(savedMealAlready(food("Milky Mist low fat paneer sabji (60 g paneer, onion, oil)", 150), [], SAVED)?.id, "s1");
  assertEquals(savedMealAlready(food("Milky Mist Low Fat Paneer Sabji", 151), [], SAVED)?.id, "s1");
  // Other numbers, or another name: a new save.
  assertEquals(savedMealAlready(food("Milky Mist Low Fat Paneer Sabji", 200), [], SAVED), null);
  assertEquals(savedMealAlready(food("Paneer bhurji", 150), [], SAVED), null);
  // A meal: every line must match.
  const card: CardLine[] = [{ ...PANEER[0], food_name: "Milky Mist Low Fat Paneer Sabji", kcal: 150 }];
  assertEquals(savedMealAlready({ name: "save_card_as_meal", input: { name: "milky mist low-fat paneer sabji" } }, card, SAVED)?.id, "s1");
  assertEquals(savedMealAlready({ name: "save_card_as_meal", input: { name: "Milky Mist Low Fat Paneer Sabji" } }, [...card, CARD[0]], SAVED), null);
});

Deno.test("a save the user already has is refused: the agent is told, and says it is in My Meals", async () => {
  const bodies: Record<string, unknown>[] = [];
  const d = deps(scripted([
    [{ name: "create_custom_food", input: { name: "Milky Mist Low Fat Paneer Sabji", kcal: 150, protein_g: 11, carb_g: 4, fat_g: 10, summary: "Want it in My Meals?" } }],
    [{ name: "reply", input: { text: "Your paneer sabji is in My Meals already." } }],
  ], bodies));
  d.savedMeals = async () => SAVED;
  const out = await runFoodAgent({ text: "save the paneer sabji as a meal", defaultMeal: "lunch", card: CARD, later: true }, d);
  assertEquals(out.kind, "reply");
  assert(resultsBefore(bodies, 2)[0].includes("already has"), resultsBefore(bodies, 2)[0]);
  // On the last turn the user still gets the true answer, from code.
  const last = deps(scripted([[{ name: "create_custom_food", input: { name: "Milky Mist Low Fat Paneer Sabji", kcal: 150 } }]]));
  last.savedMeals = async () => SAVED;
  const script: Use[][] = Array.from({ length: MAX_TURNS_LATER }, () => [{ name: "create_custom_food", input: { name: "Milky Mist Low Fat Paneer Sabji", kcal: 150 } }]);
  last.callModel = scripted(script);
  const end = await runFoodAgent({ text: "save the paneer sabji as a meal", defaultMeal: "lunch", card: CARD, later: true }, last);
  assertEquals(end.kind, "reply");
  if (end.kind === "reply") assertEquals(end.text, "Milky Mist Low Fat Paneer Sabji is in My Meals already, with these same foods.");
});

Deno.test("FOOD_AGENT_SYSTEM_LATER: an earlier ask never carried out is said plainly and done now", () => {
  assert(FOOD_AGENT_SYSTEM_LATER.includes("never carried out"));
  assert(FOOD_AGENT_SYSTEM_LATER.includes("say plainly that it was not done, and do it now in the same turn"));
  assert(FOOD_AGENT_SYSTEM_LATER.includes("that no save card answered"));
  assertFalse(FOOD_AGENT_SYSTEM_LATER.includes("—"));
});

// ── 3. 0 g / 0 kcal lines ──────────────────────────────────────────────────

const POORI_LABEL: LabelFound = {
  name: "poori", brand: null, base_unit: "g",
  per_100: { kcal: 296.6, protein_g: 7.5, carb_g: 46.7, fat_g: 9.4, fiber_g: null },
  serving: { label: "1 Poori (36g, ~12cm diameter)", grams: 36 },
  piece: { label: "1 Poori (36g, ~12cm diameter)", grams: 36 },
  verified: true,
};

Deno.test("lineFromLabel: a line counted in pieces weighs pieces x the label's piece", () => {
  const poori: CardLine = { food_name: "poori", quantity: 3, serving_label: "piece", grams: 0, kcal: 639, source: "catalog" };
  const out = lineFromLabel(poori, POORI_LABEL, "snack");
  assertEquals(out.grams, 108);
  assertEquals(Math.round(out.kcal), 320);
  assertEquals(out.serving_label, "piece (36 g)");
  for (const unit of ["pcs", "nos", "each", "pc"]) {
    assertEquals(lineFromLabel({ ...poori, serving_label: unit }, POORI_LABEL, "snack").grams, 108, unit);
  }
  // The label's own piece word still works, and a weight line keeps its grams.
  assertEquals(lineFromLabel({ ...poori, serving_label: "pooris" }, POORI_LABEL, "snack").grams, 108);
  assertEquals(lineFromLabel({ ...poori, quantity: 50, serving_label: "g", grams: 50 }, POORI_LABEL, "snack").grams, 50);
});

Deno.test("zeroKcalLine: 0 kcal is refused unless the food's own numbers are near zero", () => {
  const l = (kcal: number, grams: number, p = 0, c = 0, f = 0) => ({ kcal, grams, protein_g: p, carb_g: c, fat_g: f });
  assert(zeroKcalLine(l(0, 0)));               // no weight, no calories: the amount was lost
  assert(zeroKcalLine(l(0, 50, 6, 20, 2)));    // bread at 0 kcal: its macros say otherwise
  assertFalse(zeroKcalLine(l(0, 240)));        // black coffee, water: the numbers are near zero
  assertFalse(zeroKcalLine(l(2, 240)));
  assertFalse(zeroKcalLine(l(150, 0)));        // no weight known, calories known: a real state
  assert(zeroKcalLine(l(0, 0), 296.6));        // the label says the food has calories
  assertFalse(zeroKcalLine(l(0, 0), 0.8));
});

Deno.test("a change that leaves a food at 0 kcal goes back to the agent; the fixed amount lands", async () => {
  const bodies: Record<string, unknown>[] = [];
  const d = deps(scripted([
    [{ name: "edit_line", input: { line_id: "L1", change: "3 small" } }],
    [{ name: "edit_line", input: { line_id: "L1", change: "3 small roti, 30 g each" } }],
  ], bodies));
  d.editLine = async (_i, change) =>
    result([change.includes("30 g") ? item("Roti", 270, { grams: 90 }) : item("Roti", 0, { grams: 0, protein_g: 0, carb_g: 0, fat_g: 0 })]);
  const out = await runFoodAgent({ ...LATER, text: "the roti were small, 3 of them" }, d);
  assert(resultsBefore(bodies, 2)[0].includes("came out at 0 kcal"), resultsBefore(bodies, 2)[0]);
  assertEquals(out.kind, "log");
  if (out.kind === "log") assertEquals(out.result.parsed?.items[0].kcal, 270);
});

Deno.test("on the last turn a 0 kcal edit leaves its line as it was, and the user is told", async () => {
  const script: Use[][] = Array.from({ length: MAX_TURNS_LATER }, () => [{ name: "edit_line", input: { line_id: "L1", change: "3 small" } }]);
  const d = deps(scripted(script));
  d.editLine = async () => result([item("Roti", 0, { grams: 0, protein_g: 0, carb_g: 0, fat_g: 0 })]);
  const out = await runFoodAgent({ ...LATER, text: "the roti were small" }, d);
  // Nothing changed: the card is as it was, with the reason.
  assertEquals(out.kind, "reply");
  if (out.kind === "reply") assert(out.text.includes("could not work out an amount for Roti"), out.text);
});

// ── 4. use_label prices the amount the user stated ─────────────────────────

const BUTTERMILK_LABEL: LabelFound = {
  name: "Amul protein buttermilk", brand: "Amul", base_unit: "ml",
  per_100: { kcal: 54, protein_g: 7.5, carb_g: 4, fat_g: 0.5, fiber_g: null },
  serving: null, piece: null, verified: true,
};
const BUTTERMILK: CardLine = { food_name: "Amul protein buttermilk", quantity: 1, serving_label: "100 g", grams: 100, kcal: 54, source: "catalog", meal_type: "snack" };

Deno.test("statedAmount: a weight, a volume, or a count of something; never a macro or an energy", () => {
  assertEquals(statedAmount("1 tetrapack (Amul protein buttermilk), numbers from the label"), { count: 1, word: "tetrapack", grams: null, unit: null, each: false });
  assertEquals(statedAmount("it was 200 ml"), { count: 1, word: null, grams: 200, unit: "ml", each: false });
  assertEquals(statedAmount("1.5 l"), { count: 1, word: null, grams: 1500, unit: "ml", each: false });
  assertEquals(statedAmount("use the label numbers, keep 65 g")?.grams, 65);
  assertEquals(statedAmount("3 small pooris, use the label figures (36 g each)"), { count: 3, word: "poori", grams: 36, unit: "g", each: true });
  assertEquals(statedAmount("2 slices")?.word, "slice");
  assertEquals(statedAmount("a bottle")?.word, "bottle");
  for (const t of ["set from the looked-up label for the amount on the card", "about 135 kcal with 9 g protein", "take a usual amount", "the user says it is 150 kcal"]) {
    assertEquals(statedAmount(t), null, t);
  }
});

Deno.test("labelLineAt: the label's sizes price a count; with none, a size from the parse is marked as assumed", () => {
  const ml = labelLineAt(BUTTERMILK, BUTTERMILK_LABEL, statedAmount("200 ml")!, "snack")!;
  assertEquals([ml.grams, ml.kcal, ml.serving_label, ml.confidence], [200, 108, "ml", "high"]);
  // A pack with no size on the label: no guess from code.
  assertEquals(labelLineAt(BUTTERMILK, BUTTERMILK_LABEL, statedAmount("1 tetrapack")!, "snack"), null);
  const usual = labelLineAt(BUTTERMILK, BUTTERMILK_LABEL, statedAmount("1 tetrapack")!, "snack", 200)!;
  assertEquals([usual.grams, usual.kcal, usual.confidence], [200, 108, "medium"]);
  assert(usual.assumption?.startsWith("Took a tetrapack as about 200 ml, a usual size"), usual.assumption ?? "");
  assertEquals(usual.serving_label, "tetrapack (about 200 ml)");
  // The label's printed serving prices a container; its piece prices pieces.
  const served = labelLineAt(BUTTERMILK, { ...BUTTERMILK_LABEL, serving: { label: "1 pack (200 ml)", grams: 200 } }, statedAmount("2 tetrapacks")!, "snack")!;
  assertEquals([served.grams, served.kcal, served.serving_label], [400, 216, "tetrapack (200 ml)"]);
  const poori: CardLine = { food_name: "poori", quantity: 3, serving_label: "piece", grams: 0, kcal: 639, source: "catalog" };
  assertEquals(labelLineAt(poori, POORI_LABEL, statedAmount("4 pooris")!, "snack")!.grams, 144);
});

function labelDeps(script: Use[][], log: string[]): FoodAgentDeps {
  const d = deps(scripted(script), log);
  d.findLabel = async () => BUTTERMILK_LABEL;
  // The parse picks a usual size for the pack (an amount, never the food's numbers).
  d.editLine = async (_i, change) => {
    log.push(`edit:${change}`);
    return result([item("Amul protein buttermilk", 70, { quantity: 1, serving_label: "tetrapack", grams: 200, source: "estimate" })]);
  };
  return d;
}

Deno.test("use_label with a stated amount: a volume is priced from the label at once", async () => {
  const log: string[] = [];
  const out = await runFoodAgent({ text: "it was 200 ml", defaultMeal: "snack", card: [BUTTERMILK], later: true }, labelDeps([
    [{ name: "find_label", input: { line_id: "L1" } }],
    [{ name: "edit_line", input: { line_id: "L1", change: "200 ml, from the label", use_label: true } }],
  ], log));
  assertEquals(out.kind, "log");
  if (out.kind === "log") assertEquals([out.result.parsed?.items[0].grams, out.result.parsed?.items[0].kcal], [200, 108]);
  assertEquals(log.filter((l) => l.startsWith("edit:")), []);
});

Deno.test("use_label with a pack the label has no size for: a usual size, assumed and said, priced from the label", async () => {
  const log: string[] = [];
  const out = await runFoodAgent({ text: "it's 1 tetrapack", defaultMeal: "snack", card: [BUTTERMILK], later: true }, labelDeps([
    [{ name: "find_label", input: { line_id: "L1" } }],
    [{ name: "edit_line", input: { line_id: "L1", change: "1 tetrapack, numbers from the label", use_label: true } }],
  ], log));
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  const line = out.result.parsed!.items[0];
  // The label's 54 per 100 at 200 ml, not the parse's own 70.
  assertEquals([line.grams, line.kcal, line.confidence, line.source], [200, 108, "medium", "web"]);
  assert(line.assumption?.includes("a usual size"), line.assumption ?? "");
  // The amount can come from the user's message when the change gives none.
  const fromMessage = await runFoodAgent({ text: "it's 1 tetrapack", defaultMeal: "snack", card: [BUTTERMILK], later: true }, labelDeps([
    [{ name: "find_label", input: { line_id: "L1" } }],
    [{ name: "edit_line", input: { line_id: "L1", change: "use the label", use_label: true } }],
  ], []));
  assertEquals(fromMessage.kind, "log");
  if (fromMessage.kind === "log") assertEquals(fromMessage.result.parsed?.items[0].kcal, 108);
  // No amount anywhere: the line keeps its amount, as before.
  const none = await runFoodAgent({ text: "check the label", defaultMeal: "snack", card: [BUTTERMILK], later: true }, labelDeps([
    [{ name: "find_label", input: { line_id: "L1" } }],
    [{ name: "edit_line", input: { line_id: "L1", change: "use the label", use_label: true } }],
  ], []));
  assertEquals(none.kind, "log");
  if (none.kind === "log") assertEquals([none.result.parsed?.items[0].grams, none.result.parsed?.items[0].kcal], [100, 54]);
});

// ── 5. build_recipe parts come from the user ───────────────────────────────

Deno.test("partsNotFromUser: every naming word of a part is in the user's words; a cooking fat with no amount may be assumed", () => {
  const ask = (parts: { name: string; amount?: string }[]) => ({ name: "Dish", parts: parts.map((p) => ({ name: p.name, amount: p.amount ?? null })) });
  const said = "a sabji with 65g Milky Mist low fat paneer, tomatoes and some onion";
  assertEquals(partsNotFromUser(ask([{ name: "Milky Mist low fat paneer", amount: "65 g" }, { name: "tomato" }, { name: "onions" }]), said), []);
  // An oil or ghee with no amount: assumed, shown, asked once (owner decision).
  assertEquals(partsNotFromUser(ask([{ name: "cooking oil" }, { name: "ghee" }]), said), []);
  // An oil with an amount the user never gave, or another part, is invented.
  assertEquals(partsNotFromUser(ask([{ name: "mustard oil", amount: "1 tbsp" }]), said), ["mustard oil"]);
  assertEquals(partsNotFromUser(ask([{ name: "cream" }, { name: "sugar" }, { name: "Milky Mist curd" }]), said), ["cream", "sugar", "Milky Mist curd"]);
});

Deno.test("build_recipe with a part the user never named is refused, and the agent hears which", async () => {
  const bodies: Record<string, unknown>[] = [];
  const d = deps(scripted([
    [{ name: "build_recipe", input: { name: "Oatmeal", line_id: "L1", parts: [{ name: "oats", amount: "55 g" }, { name: "honey" }] } }],
    [{ name: "reply", input: { text: "Which milk was it?" } }],
  ], bodies));
  d.buildRecipe = true;
  const card: CardLine[] = [{ food_name: "Oatmeal", quantity: 1, serving_label: "bowl", grams: 55, kcal: 200, source: "catalog", meal_type: "breakfast" }];
  const out = await runFoodAgent({ text: "the oatmeal had milk", defaultMeal: "breakfast", card, later: true, recentTurns: [{ role: "user", text: "55 g oats" }] }, d);
  assertEquals(out.kind, "reply");
  assert(resultsBefore(bodies, 2)[0].includes("never mentioned: honey"), resultsBefore(bodies, 2)[0]);
});

Deno.test("onlyAmount: the user's message gives this line its amount only when it can be no other line's", () => {
  const laddu = { food_name: "boondi laddu" };
  assertEquals(onlyAmount("it's 1 tetrapack", BUTTERMILK, 3)?.word, "tetrapack");
  assertEquals(onlyAmount("it was 200 ml", BUTTERMILK, 1)?.grams, 200);
  // A weight beside other lines could be theirs.
  assertEquals(onlyAmount("it was 200 ml", BUTTERMILK, 2), null);
  // Another food's amount is not this line's.
  assertEquals(onlyAmount("a third of boondi laddu and half kaju katli", laddu, 2), null);
  assertEquals(onlyAmount("2 laddus", laddu, 2)?.count, 2);
  // Two amounts: no telling which is which.
  assertEquals(onlyAmount("1 tetrapack and 2 slices", BUTTERMILK, 1), null);
});

Deno.test("review: a decimal amount is not split at its point", () => {
  const line = { food_name: "Buttermilk", said_name: "buttermilk" } as never;
  const a = onlyAmount("0.5 litre of buttermilk", line, 1);
  assert(a !== null);
  assertFalse(JSON.stringify(a).includes("5000"), JSON.stringify(a));
});

Deno.test("review: a number already on the user's line, or the word one, is not a new number", () => {
  const line = { kcal: 120, grams: 50, quantity: 1, protein_g: 6, carb_g: 10, fat_g: 4 } as never;
  assertFalse(givesNumber("why is the 120 kcal so high?", line));
  assertFalse(givesNumber("which one is wrong?", line));
  assert(givesNumber("it is 90 kcal", line));
  assert(givesNumber("make it two", line));
});

Deno.test("review: an older save ask does not stand once the user moved on", () => {
  assertEquals(unmetSaveAsk([
    { role: "user", text: "save it as a meal" },
    { role: "drona", text: "Which name should it have?" },
    { role: "user", text: "add a banana too" },
    { role: "drona", text: "Added a banana." },
  ]), null);
  assert(unmetSaveAsk([
    { role: "user", text: "save it as a meal" },
    { role: "drona", text: "Paneer keeps the protein up." },
  ]) !== null);
});
