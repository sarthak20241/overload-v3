// Run with: deno test --allow-all supabase/functions/ai-coach/findLabel.test.ts
//
// The later-message food agent (FOOD_AGENT_LATER) and labels. Live, 2026-11-07,
// on a protein bread card:
//   - "look up the label" got "I can't look up labels online": the agent had no
//     tool for it, though the app runs that lookup on every Precise log.
//   - an edit ("2 slices, 242 kcal is too high") swapped in a different catalog
//     product: the brand was gone and the protein fell.
// find_label returns the label; the code, never the model, works out the line.
// Nothing here calls a real model, Jev or the web.

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  type FoodAgentDeps,
  keepLineIdentity,
  LABEL_NOTE,
  lineFromLabel,
  runFoodAgent,
  toolsForLater,
} from "./foodAgent.ts";
import type { CardLine } from "./foodContext.ts";
import type { LabelFound, ParsedItem, ParseMealResult } from "./parseMeal.ts";

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

const BREAD: CardLine = {
  food_name: "Health Factory protein bread", quantity: 2, serving_label: "slice (25 g)", grams: 100,
  kcal: 242, protein_g: 28, carb_g: 26, fat_g: 4.4, source: "web", meal_type: "breakfast",
};
const GHEE: CardLine = {
  food_name: "ghee", quantity: 5, serving_label: "g", grams: 5, kcal: 43.8, protein_g: 0, carb_g: 0, fat_g: 5,
  source: "catalog", meal_type: "breakfast",
};
const CARD = [BREAD, GHEE];

/** The label as the owner read it: 2 slices = 50 g = 121 kcal, 11 g protein. */
const LABEL: LabelFound = {
  name: "Health Factory Protein Bread", brand: "Health Factory", base_unit: "g",
  per_100: { kcal: 242, protein_g: 22, carb_g: 30.6, fat_g: 3.4, fiber_g: null },
  serving: { label: "2 slices (50 g)", grams: 50 },
  piece: { label: "1 slice", grams: 25 },
  verified: false,
};

function deps(callModel: FoodAgentDeps["callModel"], log: string[], label: LabelFound | null = LABEL): FoodAgentDeps {
  return {
    model: "sonnet",
    callModel,
    readDiary: async () => ({ meals: [] }),
    savedMeals: async () => [],
    parseFood: async (t) => {
      log.push(`parse:${t}`);
      throw new Error("no parse expected");
    },
    editLine: async (i, change) => {
      log.push(`edit:${i}:${change}`);
      throw new Error("no edit parse expected");
    },
    findLabel: async (p) => {
      log.push(`label:${p.name}`);
      return label;
    },
  };
}

Deno.test("lineFromLabel: 2 slices from a label of 2 slices (50 g) are 50 g and 121 kcal", () => {
  const out = lineFromLabel(BREAD, LABEL, "breakfast");
  assertEquals(out.food_name, "Health Factory protein bread");
  assertEquals([out.quantity, out.serving_label, out.grams, out.kcal, out.protein_g], [2, "slice (25 g)", 50, 121, 11]);
  assertEquals(out.source, "web");
});

Deno.test("lineFromLabel: a weight line keeps its weight; a unit the label has no piece for keeps its grams", () => {
  const grams: CardLine = { ...BREAD, quantity: 60, serving_label: "g", grams: 60 };
  assertEquals(lineFromLabel(grams, LABEL, "breakfast").grams, 60);
  const loaf: CardLine = { ...BREAD, quantity: 1, serving_label: "serving", grams: 80 };
  const out = lineFromLabel(loaf, LABEL, "breakfast");
  assertEquals([out.grams, out.kcal], [80, 193.6]);
});

Deno.test("lineFromLabel: a label with no piece still fixes a line whose own unit weight disagrees", () => {
  // The recorded card: 2 x "slice (25 g)" over 100 g.
  const out = lineFromLabel(BREAD, { ...LABEL, piece: null, serving: null }, "breakfast");
  assertEquals([out.grams, out.kcal], [50, 121]);
});

Deno.test("find_label is offered beside a card, with a note that says so, only when the lookup exists", () => {
  assert(toolsForLater(CARD, false, {}, true).some((t) => t.name === "find_label"));
  assertFalse(toolsForLater(CARD, false, {}, false).some((t) => t.name === "find_label"));
  assert(LABEL_NOTE.includes("find_label"));
});

Deno.test("look up the label: find_label, then edit_line with use_label puts the code's line on the card", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "look up the label for Health Factory protein bread", defaultMeal: "breakfast", card: CARD, later: true },
    deps(scripted([
      [{ name: "find_label", input: { line_id: "L1" } }],
      [
        { name: "edit_line", input: { line_id: "L1", change: "use the label", use_label: true } },
        { name: "reply", input: { text: "Checked the label and set the bread from it." } },
      ],
    ], bodies), log),
  );
  assertEquals(log, ["label:Health Factory protein bread"]);
  // The system prompt says the tool exists; the tool list has it.
  assert(String(bodies[0].system).includes(LABEL_NOTE));
  assert((bodies[0].tools as { name: string }[]).some((t) => t.name === "find_label"));
  // The model saw the line the code worked out.
  const second = JSON.stringify(bodies[1].messages);
  assert(second.includes("line_from_label"));
  assert(second.includes("121"));
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  const items = out.result.parsed!.items;
  assertEquals(items.length, 2);
  assertEquals([items[0].food_name, items[0].grams, items[0].kcal, items[0].protein_g], ["Health Factory protein bread", 50, 121, 11]);
  // Every other line exactly as it was.
  assertEquals([items[1].food_name, items[1].grams, items[1].source], ["ghee", 5, "catalog"]);
});

Deno.test("no label found: the line stays, and use_label without a label changes nothing", async () => {
  const log: string[] = [];
  const out = await runFoodAgent(
    { text: "check the label", defaultMeal: "breakfast", card: CARD, later: true },
    deps(scripted([
      [{ name: "find_label", input: { line_id: "L1" } }],
      [{ name: "edit_line", input: { line_id: "L1", change: "use the label", use_label: true } }],
    ]), log, null),
  );
  assertEquals(out.kind, "reply");
});

Deno.test("find_label and edit_line in one turn: the edit waits for the label", async () => {
  const log: string[] = [];
  const out = await runFoodAgent(
    { text: "look up the label", defaultMeal: "breakfast", card: CARD, later: true },
    deps(scripted([
      [
        { name: "find_label", input: { line_id: "L1" } },
        { name: "edit_line", input: { line_id: "L1", change: "use the label", use_label: true } },
      ],
      [{ name: "edit_line", input: { line_id: "L1", change: "use the label", use_label: true } }],
    ]), log),
  );
  assertEquals(out.kind, "log");
  if (out.kind === "log") assertEquals(out.result.parsed!.items[0].kcal, 121);
});

const edited = (o: Partial<ParsedItem>): ParsedItem => ({
  food_id: "zm-1", food_name: "Zero Maida Protein Bread", quantity: 2, serving_label: "slice (25 g)", grams: 50,
  kcal: 110, protein_g: 6, carb_g: 20, fat_g: 1, fiber_g: null, source: "catalog", assumption: null, confidence: "high", ...o,
});

Deno.test("keepLineIdentity: an amount edit keeps the user's product, at its own numbers per gram", () => {
  const out = keepLineIdentity(BREAD, edited({}), "2 slices only, 242 kcal is too high for 2 slices");
  assertEquals([out.food_name, out.grams, out.kcal, out.protein_g, out.source], ["Health Factory protein bread", 50, 121, 14, "web"]);
});

Deno.test("keepLineIdentity: numbers the user stated are kept, whatever the name", () => {
  const stated = edited({ food_name: "Multigrain protein loaf", protein_g: 11, kcal: 121, source: "manual" });
  assertEquals(keepLineIdentity(BREAD, stated, "the user says protein is 11 g for the 2 slices"), stated);
});

Deno.test("keepLineIdentity: a new name that keeps the user's words stands", () => {
  const roti: CardLine = { food_name: "Roti", quantity: 2, serving_label: "piece", grams: 80, kcal: 240, protein_g: 7, carb_g: 36, fat_g: 7.4, source: "catalog" };
  const ww = edited({ food_name: "Whole Wheat Roti", grams: 80, kcal: 220 });
  assertEquals(keepLineIdentity(roti, ww, "the protein looks wrong"), ww);
});

Deno.test("use_label: a label found by product only is not put on a line", async () => {
  const out = await runFoodAgent(
    { text: "look up the label", defaultMeal: "breakfast", card: CARD, later: true },
    deps(scripted([
      [{ name: "find_label", input: { product: "Health Factory protein bread" } }],
      [{ name: "edit_line", input: { line_id: "L1", change: "use the label", use_label: true } }],
    ]), []),
  );
  assertEquals(out.kind, "reply");
});

Deno.test("keepLineIdentity: a change that names another food takes it", () => {
  const out = keepLineIdentity(BREAD, edited({}), "it was the zero maida protein bread");
  assertEquals(out.food_name, "Zero Maida Protein Bread");
  // Same food, a new amount: the edit stands as worked out.
  const same = edited({ food_name: "Health Factory protein bread", kcal: 121 });
  assertEquals(keepLineIdentity(BREAD, same, "2 slices"), same);
});

// A ParseMealResult type check, so the import is used and a shape change shows here.
const _r: ParseMealResult | null = null;
void _r;
