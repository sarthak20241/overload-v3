// Region rules for the Precise food prompts (plan step 6, section 10).
//
// Behind FOOD_REGION_RULES (off by default), Precise only. Read by
// parseMeal.ts (extract and decide), foodAgent.ts, ourSources.ts and
// preciseMatch.ts (Jev's kind question); index.ts reads the time zone.
//
// The region comes from the user's time zone through countryForTimezone, the
// same function the web search uses. An unknown zone is no region: no
// regional defaults, and any assumption is said on the card.
//
// Rules are stored here word for word as they read in today's prompts. With
// FOOD_REGION_RULES on, regionalizePrompt removes each rule from the shared
// prompt and puts it in a late region block, only for its region. Examples
// are swapped per region; India keeps today's text.
//
// Import-free apart from searchCountry.ts, so deno can test it alone.

import { countryForTimezone } from "./searchCountry.ts";

export type FoodRegion = "india" | "us" | "uk" | "europe";
export type RegionPrompt = "extract" | "decide" | "agent" | "jev";

export function parseFoodRegionRulesMode(v: string | null | undefined): "off" | "on" {
  return v === "on" ? "on" : "off";
}

/** Europe, by searchCountry.ts's country names (exact lowercase strings). Any other
 *  zone is no region, the safe default. */
const EU = new Set([
  "ireland", "france", "germany", "spain", "italy", "netherlands", "belgium", "austria", "sweden",
  "denmark", "finland", "poland", "portugal", "greece", "switzerland", "norway",
]);

export function foodRegionForCountry(country: string | null | undefined): FoodRegion | null {
  if (!country) return null;
  if (country === "india") return "india";
  if (country === "united states") return "us";
  if (country === "united kingdom") return "uk";
  if (EU.has(country)) return "europe";
  return null;
}

/** No fallback: a user with no zone stored has no region. */
export function foodRegionForTimezone(tz: string | null | undefined): FoodRegion | null {
  return foodRegionForCountry(countryForTimezone(tz, null));
}

export interface RegionRule {
  id: string;
  prompt: RegionPrompt;
  /** The exact text in today's prompt, separator included, that is removed. */
  text: string;
  /** The same words, as they read in the region block. */
  block: string;
}

const INDIA_TEA_EXTRACT =
  `Indian context: unqualified "tea" or "chai" means milk tea, extract the name as "milk tea"; unqualified "coffee" as "milk coffee" (keep "black tea", "green tea", "black coffee" as stated).`;
const INDIA_STAPLES =
  "For generic Indian foods prefer the curated staples (Roti, Toor Dal, Curd, Toned Milk) over obscure branded rows.";
const INDIA_BEVERAGES =
  `- Indian beverage defaults: unqualified "tea" or "chai" means MILK tea (the Chai / Milk Tea row, ~45 kcal/100 ml), and unqualified "coffee" means milk coffee. Herbal, black, green, or lemon tea ONLY when the user says so; picking a 1-2 kcal plain-tea row for unqualified "tea" is wrong. Any such default is never confidence high; name it in assumption.`;

export const REGION_RULES: Record<FoodRegion, RegionRule[]> = {
  india: [
    { id: "india_tea_extract", prompt: "extract", text: " " + INDIA_TEA_EXTRACT, block: INDIA_TEA_EXTRACT },
    { id: "india_staples", prompt: "decide", text: " " + INDIA_STAPLES, block: "- " + INDIA_STAPLES },
    { id: "india_beverages", prompt: "decide", text: "\n" + INDIA_BEVERAGES, block: INDIA_BEVERAGES },
  ],
  us: [],
  uk: [],
  europe: [],
};

/** An example in today's prompt (India's text), and what each other region
 *  reads instead. A region left out keeps today's example: that is one of
 *  its "1 or 2 from elsewhere". */
export interface RegionSwap {
  prompt: RegionPrompt;
  from: string;
  to: Partial<Record<Exclude<FoodRegion, "india"> | "none", string>>;
}

export const REGION_SWAPS: RegionSwap[] = [
  // extract
  { prompt: "extract", from: `"panner" is "paneer"`, to: { us: `"brocoli" is "broccoli"`, uk: `"brocoli" is "broccoli"`, europe: `"brocoli" is "broccoli"` } },
  { prompt: "extract", from: `("rajma chawal")`, to: { us: `("chili con carne")`, uk: `("shepherd's pie")`, europe: `("paella")` } },
  { prompt: "extract", from: `("paneer and 2 roti" is two)`, to: { us: `("chicken and 2 tortillas" is two)`, uk: `("bacon and 2 slices of toast" is two)`, europe: `("cheese and 2 slices of bread" is two)`, none: `("chicken and 2 slices of toast" is two)` } },
  { prompt: "extract", from: `"actually paneer not tofu"`, to: { us: `"actually chicken not tofu"`, uk: `"actually chicken not tofu"`, europe: `"actually chicken not tofu"`, none: `"actually chicken not tofu"` } },
  { prompt: "extract", from: `"and a dosa", "also 2 roti"`, to: { us: `"and a bagel", "also 2 tortillas"`, uk: `"and a crumpet", "also 2 slices of toast"`, europe: `"and a croissant", "also 2 slices of bread"`, none: `"and a dosa", "also 2 slices of toast"` } },
  { prompt: "extract", from: `"scratch the dosa"`, to: { us: `"scratch the bagel"`, uk: `"scratch the crumpet"`, europe: `"scratch the croissant"` } },
  // decide
  { prompt: "decide", from: "(toned milk is 3% fat by regulation, so Amul = Mother Dairy; likewise curd, plain paneer, ghee, oil, atta, rice, dal, eggs)", to: {
    us: "(plain whole milk is made to a set standard, so one store's whole milk = another's; likewise eggs, butter, oil, flour, plain rice, oats)",
    uk: "(semi-skimmed milk is made to a set standard, so one supermarket's = another's; likewise eggs, butter, oil, flour, plain rice, oats)",
    europe: "(whole milk is made to a set standard, so one dairy's whole milk = another's; likewise eggs, butter, oil, flour, plain rice, oats)",
    none: "(plain milk of one fat grade is made to a set standard, so one brand's = another's; likewise eggs, butter, oil, flour, plain rice, oats)",
  } },
  { prompt: "decide", from: "regional synonyms (doodh = milk, dahi = curd, chawal = rice)", to: {
    us: "regional synonyms (garbanzo beans = chickpeas, scallions = green onions)",
    uk: "regional synonyms (courgette = zucchini, crisps = potato chips)",
    europe: "regional synonyms (Joghurt = yogurt, riz = rice)",
    none: "regional synonyms (curd = plain yogurt, garbanzo beans = chickpeas)",
  } },
  { prompt: "decide", from: "a DISH reduced to an ingredient (paneer butter masala is not Paneer)", to: {
    us: "a DISH reduced to an ingredient (chicken pot pie is not Chicken)",
    uk: "a DISH reduced to an ingredient (chicken tikka masala is not Chicken)",
    europe: "a DISH reduced to an ingredient (chicken paella is not Chicken)",
  } },
  { prompt: "decide", from: `paneer bhurji at 9pm is dinner, not breakfast`, to: {
    us: "a stack of pancakes at 9pm is dinner, not breakfast", uk: "a full English at 9pm is dinner, not breakfast",
    europe: "a croissant at 9pm is dinner, not breakfast", none: "oatmeal at 9pm is dinner, not breakfast",
  } },
  { prompt: "decide", from: "(Haldiram's bhujia, Epigamia yogurt, etc.)", to: {
    us: "(Doritos, Chobani yogurt, etc.)", uk: "(Walkers crisps, Müller yogurt, etc.)",
    europe: "(Haribo gummies, Danone yogurt, etc.)", none: "(Doritos, Haldiram's bhujia, etc.)",
  } },
  // agent
  { prompt: "agent", from: `from tea, sugar, biscuits and poha, "the chai" is the tea and sugar`, to: {
    us: `from coffee, creamer, toast and eggs, "the coffee" is the coffee and creamer`,
    uk: `from tea, milk, toast and beans, "the tea" is the tea and milk`,
    europe: `from coffee, milk, bread and jam, "the coffee" is the coffee and milk`,
  } },
  { prompt: "agent", from: `"the chai I had at breakfast" is still only the tea and sugar`, to: {
    us: `"the coffee I had at breakfast" is still only the coffee and creamer`,
    uk: `"the tea I had at breakfast" is still only the tea and milk`,
    europe: `"the coffee I had at breakfast" is still only the coffee and milk`,
  } },
  { prompt: "agent", from: "(half the rice, without the naan)", to: {
    us: "(half the rice, without the fries)", uk: "(half the rice, without the chips)",
    europe: "(half the rice, without the bread)", none: "(half the rice, without the fries)",
  } },
  { prompt: "agent", from: "(another roti, a second egg)", to: {
    us: "(another tortilla, a second egg)", uk: "(another slice of toast, a second egg)", europe: "(another slice of bread, a second egg)",
  } },
  // jev (preciseMatch.ts kind question)
  { prompt: "jev", from: "Examples: dal tadka, poha, aloo paratha, pav bhaji.", to: {
    us: "Examples: mac and cheese, chili, pancakes, dal tadka.", uk: "Examples: shepherd's pie, porridge, beans on toast, dal tadka.",
    europe: "Examples: paella, risotto, goulash, dal tadka.", none: "Examples: dal tadka, poha, chili, risotto.",
  } },
];

const BLOCK_INTRO: Record<FoodRegion, string> = {
  india: "This user is in India.",
  us: "This user is in the United States. Amounts may come in US units (cup, oz, lb, fl oz).",
  uk: "This user is in the United Kingdom. Amounts may come in UK words (a pint, a mug, a rasher, a slice).",
  europe: "This user is in Europe. Amounts are usually metric.",
};

const NO_REGION =
  "We do not know where this user lives. Apply no regional default: when a food's usual form depends on the " +
  "country (tea or coffee with or without milk, the size of a cup or bowl), take the food as written and name " +
  "what you assumed in assumption, never confidence high.";

/** The late block for one prompt. Only extract and decide carry one. With no
 *  region, extract gets nothing on purpose: it keeps "tea" and "coffee" as
 *  written, and decide's no-region block makes it say what it assumed. */
export function regionBlock(prompt: RegionPrompt, region: FoodRegion | null): string {
  if (prompt !== "extract" && prompt !== "decide") return "";
  if (!region) return prompt === "decide" ? `\n<region_rules>\n${NO_REGION}\n</region_rules>\n` : "";
  const rules = REGION_RULES[region].filter((r) => r.prompt === prompt).map((r) => r.block);
  if (prompt === "extract") return rules.length ? " " + rules.join(" ") : "";
  return `\n<region_rules>\n${[BLOCK_INTRO[region], ...rules].join("\n")}\n</region_rules>\n`;
}

/** Today's prompt with every region rule taken out and this region's
 *  examples in. The block is NOT added here: the caller puts it late. */
export function regionalizePrompt(prompt: RegionPrompt, base: string, region: FoodRegion | null): string {
  let out = base;
  for (const r of Object.values(REGION_RULES).flat()) if (r.prompt === prompt) out = out.split(r.text).join("");
  if (region === "india") return out;
  const key = region ?? "none";
  for (const s of REGION_SWAPS) {
    if (s.prompt !== prompt) continue;
    const to = s.to[key];
    if (to !== undefined) out = out.split(s.from).join(to);
  }
  return out;
}
