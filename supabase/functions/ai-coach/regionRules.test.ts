// Run with: deno test --allow-all supabase/functions/ai-coach/regionRules.test.ts
//
// Plan step 6 (FOOD_REGION_RULES): region rules in the Precise prompts only
// for their region. What these pin:
//   - the switch off leaves every prompt exactly as it is today
//   - each region gets its own block and only its own block; no region gets
//     the no-region block, never India's rules
//   - every rule in today's prompts is in exactly one block, word for word,
//     so moving them lost nothing
//   - every example swap still points at text that exists today

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type FoodRegion,
  foodRegionForTimezone,
  parseFoodRegionRulesMode,
  REGION_RULES,
  REGION_SWAPS,
  type RegionPrompt,
} from "./regionRules.ts";
import { buildDecideSystemPrompt, preciseExtractSystem, type ParseMealInput, waitForRegion } from "./parseMeal.ts";
import { FOOD_AGENT_SYSTEM, FOOD_AGENT_SYSTEM_LATER, CARD_NOTE_LATER, type FoodAgentDeps, runFoodAgent } from "./foodAgent.ts";
import { kindQuestion } from "./preciseMatch.ts";

const REGIONS: (FoodRegion | null)[] = ["india", "us", "uk", "europe", null];
const INTROS: Record<FoodRegion, string> = {
  india: "This user is in India.",
  us: "This user is in the United States.",
  uk: "This user is in the United Kingdom.",
  europe: "This user is in Europe.",
};
const NO_REGION = "We do not know where this user lives.";

const input = {
  text: "lunch",
  localHour: 13,
  mealHint: null,
  recentFoods: [],
  todayTotals: null,
  targets: null,
} as unknown as ParseMealInput;

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const decideFor = (region: FoodRegion | null) => buildDecideSystemPrompt(input, { region });
const extractFor = (region: FoodRegion | null, previous = false) => preciseExtractSystem(previous, { region });
const allRules = Object.values(REGION_RULES).flat();

function promptsFor(region: FoodRegion | null): Record<"extract" | "decide", string> {
  return { extract: extractFor(region) + extractFor(region, true), decide: decideFor(region) };
}

Deno.test("the switch reads on only for 'on'", () => {
  assertEquals(parseFoodRegionRulesMode("on"), "on");
  assertEquals(parseFoodRegionRulesMode(undefined), "off");
  assertEquals(parseFoodRegionRulesMode("shadow"), "off");
});

Deno.test("the region comes from the time zone, with no fallback", () => {
  assertEquals(foodRegionForTimezone("Asia/Kolkata"), "india");
  assertEquals(foodRegionForTimezone("America/New_York"), "us");
  assertEquals(foodRegionForTimezone("America/Indiana/Indianapolis"), "us");
  assertEquals(foodRegionForTimezone("Europe/London"), "uk");
  assertEquals(foodRegionForTimezone("Europe/Berlin"), "europe");
  assertEquals(foodRegionForTimezone("Europe/Zurich"), "europe");
  assertEquals(foodRegionForTimezone("Europe/Moscow"), null);
  assertEquals(foodRegionForTimezone("Asia/Tokyo"), null);
  assertEquals(foodRegionForTimezone(null), null);
  assertEquals(foodRegionForTimezone(""), null);
});

Deno.test("switch off: the Precise prompts are today's, with no block", () => {
  const off = preciseExtractSystem(false) + buildDecideSystemPrompt(input);
  assert(!off.includes("<region_rules>"));
  for (const intro of [...Object.values(INTROS), NO_REGION]) assert(!off.includes(intro), intro);
  // Today's India rules are in today's prompts, each exactly once.
  for (const r of allRules) {
    const today = r.prompt === "extract" ? preciseExtractSystem(false) : buildDecideSystemPrompt(input);
    assertEquals(count(today, r.text), 1, `rule ${r.id} is not in today's ${r.prompt} prompt word for word`);
  }
});

Deno.test("every rule is in exactly one block: its own region's, word for word", () => {
  for (const region of REGIONS) {
    const p = promptsFor(region);
    for (const r of allRules) {
      const own = (Object.entries(REGION_RULES) as [FoodRegion, typeof allRules][])
        .find(([, rules]) => rules.includes(r))![0];
      const where = r.prompt === "extract" ? extractFor(region) : decideFor(region);
      assertEquals(count(where, r.block), own === region ? 1 : 0, `rule ${r.id} for region ${region}`);
    }
    // Nothing of a rule is left in the shared part either.
    if (region !== "india") for (const r of allRules) assert(!p[r.prompt as "extract" | "decide"].includes(r.block), r.id);
  }
});

Deno.test("each region gets its own block and only its own block", () => {
  for (const region of REGIONS) {
    const d = decideFor(region);
    assertEquals(count(d, "<region_rules>"), 1, `block for ${region}`);
    for (const [r, intro] of Object.entries(INTROS)) assertEquals(count(d, intro), r === region ? 1 : 0, `${intro} in ${region}`);
    assertEquals(count(d, NO_REGION), region === null ? 1 : 0, `no-region block in ${region}`);
  }
});

Deno.test("the block comes late: after the shared rules, before the user's own context", () => {
  for (const region of REGIONS) {
    const d = decideFor(region);
    assert(d.indexOf("</behavior>") < d.indexOf("<region_rules>"), `${region}: block before behavior`);
    assert(d.indexOf("</region_rules>") < d.indexOf("<user_context>"), `${region}: block after user_context`);
  }
  const e = extractFor("india");
  assert(e.endsWith(REGION_RULES.india.find((r) => r.prompt === "extract")!.block));
});

Deno.test("examples: other regions read their own, with at most 2 borrowed from India", () => {
  for (const region of ["us", "uk", "europe"] as const) {
    for (const prompt of ["extract", "decide"] as const) {
      const p = promptsFor(region)[prompt];
      const left = REGION_SWAPS.filter((s) => s.prompt === prompt && p.includes(s.from));
      assert(left.length <= 2, `${region} ${prompt} keeps ${left.map((s) => s.from).join(" | ")}`);
      for (const s of REGION_SWAPS.filter((s) => s.prompt === prompt && s.to[region])) {
        assert(p.includes(s.to[region]!), `${region} ${prompt}: ${s.to[region]}`);
      }
    }
  }
  // India keeps today's examples.
  for (const s of REGION_SWAPS.filter((s) => s.prompt === "extract" || s.prompt === "decide")) {
    assert(promptsFor("india")[s.prompt as "extract" | "decide"].includes(s.from), s.from);
  }
});

Deno.test("every example swap points at text that exists in today's prompt", () => {
  const today: Record<RegionPrompt, string> = {
    extract: preciseExtractSystem(false) + preciseExtractSystem(true),
    decide: buildDecideSystemPrompt(input),
    agent: FOOD_AGENT_SYSTEM + FOOD_AGENT_SYSTEM_LATER + CARD_NOTE_LATER,
    jev: JSON.stringify(kindQuestion("f1")),
  };
  for (const s of REGION_SWAPS) assert(today[s.prompt].includes(s.from), `${s.prompt}: ${s.from}`);
});

Deno.test("Jev's kind question: India's dish examples only for India", () => {
  assertEquals(JSON.stringify(kindQuestion("f1")), JSON.stringify(kindQuestion("f1", { region: "india" })));
  const us = JSON.stringify(kindQuestion("f1", { region: "us" }));
  assert(us.includes("mac and cheese"));
  assert(!us.includes("pav bhaji"));
});

/** A model that replies at once and records the system prompt. */
function replyDeps(systems: string[]): FoodAgentDeps {
  return {
    model: "sonnet",
    callModel: async (body) => {
      systems.push(JSON.stringify(body.system));
      return {
        ok: true,
        data: {
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id: "t1", name: "reply", input: { text: "Sure." } }],
        },
      };
    },
    readDiary: async () => ({ meals: [] }),
    savedMeals: async () => [],
    parseFood: async () => { throw new Error("not used"); },
  };
}

Deno.test("the food agent: examples by region only when region rules are on", async () => {
  for (const later of [false, true]) {
    const run = async (regionRules?: { region: FoodRegion | null }) => {
      const systems: string[] = [];
      await runFoodAgent({ text: "hi", defaultMeal: "lunch", ...(later ? { later } : {}), ...(regionRules ? { regionRules } : {}) }, replyDeps(systems));
      return systems[0];
    };
    const off = await run();
    assert(off.includes("the chai"));
    assertEquals(await run({ region: "india" }), off);
    for (const region of ["us", "uk", "europe"] as const) {
      const p = await run({ region });
      for (const w of ["chai", "naan", "roti", "poha"]) assert(!p.includes(w), `${region} later=${later}: ${w}`);
    }
    // No region: mixed, today's chai example kept as the one from elsewhere.
    assert((await run({ region: null })).includes("the chai"));
  }
});

Deno.test("a slow region read is no region, and says it timed out", async () => {
  assertEquals(await waitForRegion(async () => "us", 50), { region: "us", timedOut: false });
  assertEquals(await waitForRegion(() => new Promise((r) => setTimeout(() => r("us"), 200)), 20), { region: null, timedOut: true });
  assertEquals(await waitForRegion(() => Promise.reject(new Error("down")), 50), { region: null, timedOut: false });
});
