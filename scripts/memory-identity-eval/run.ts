// Real-Jev test set for the user's food memory (owner decision 2026-10-11):
// Jev judges identity only - is this remembered food what the user means? -
// and code chooses between several that are.
//
//   deno run -A scripts/memory-identity-eval/run.ts            # new question
//   OLD=1 deno run -A scripts/memory-identity-eval/run.ts      # + the old one, for comparison
//
// Needs JEV_API_KEY (env or .env.local). One Jev call per case; no Anthropic
// calls. Cases marked "real" are one user's live rows from 2026-10-06..08.

import { askJev, type JevQuestion } from "../../supabase/functions/ai-coach/jev.ts";
import { decideMemory, type MemoryFood, memoryQuestions } from "../../supabase/functions/ai-coach/userFoodMemory.ts";

type Level = "different" | "unclear" | "same";
interface Case {
  id: string;
  real?: boolean;
  typed: string;
  /** Remembered row -> the answers that count as right. */
  rows: Record<string, Level[]>;
  /** The food decideMemory should serve, or null for none. Optional. */
  serves?: string | null;
  /** How often she logged each row (decideMemory ranks by it). */
  times?: Record<string, number>;
}

const S: Level[] = ["same"], D: Level[] = ["different"], U: Level[] = ["unclear"];
const SU: Level[] = ["same", "unclear"], UD: Level[] = ["unclear", "different"];

const CASES: Case[] = [
  {
    id: "cucumber", real: true, typed: "cucumber",
    rows: { "cucumber": S, "cucumbers": S, "Cucumber, raw": S, "carrot": D, "cashew": D, "casein": D },
    times: { "cucumber": 7, "cucumbers": 1, "Cucumber, raw": 1 }, serves: "cucumber",
  },
  {
    id: "whole-egg", real: true, typed: "whole egg",
    rows: { "whole egg": S, "whole eggs": S, "Egg, whole, raw": SU, "egg white": D, "boiled egg white": D, "boiled eggs": SU },
    times: { "whole egg": 3, "whole eggs": 2 }, serves: "whole egg",
  },
  {
    id: "casein", real: true, typed: "casein",
    rows: {
      "casein": S, "Myprotein unflavoured casein": S, "MyProtein MyProtein Impact Casein Protein, Unflavoured": S,
      "Amul Protein Lassi - Rose Flavour": D, "Superyou protein puff": D,
    },
    times: { "Myprotein unflavoured casein": 4, "casein": 2 }, serves: "Myprotein unflavoured casein",
  },
  {
    id: "royal-gala", real: true, typed: "royal gala apple",
    rows: { "apple": SU, "Apple, raw": SU, "Muscleblaze Apple Cinnamon Protein Oats": D },
  },
  {
    id: "cocoa", real: true, typed: "cocoa powder",
    rows: { "Cocoa, dry powder, unsweetened": S, "Farmley date powder": D, "Chia seeds": D },
    serves: "Cocoa, dry powder, unsweetened",
  },
  {
    id: "walnut", real: true, typed: "walnut",
    rows: { "walnuts": S, "walnut": S, "Almond butter": D },
  },
  {
    id: "veggies", real: true, typed: "veggies",
    rows: { "Veggies": S, "vegetables": S, "Mixed vegetables": SU, "vegetables and seasoning": SU },
  },
  {
    id: "whey-variants", typed: "whey",
    rows: { "chocolate whey": S, "vanilla whey": S, "casein": D },
    times: { "chocolate whey": 3, "vanilla whey": 1 }, serves: "chocolate whey",
  },
  {
    id: "flavour-conflict", typed: "chocolate whey",
    rows: { "vanilla whey": D, "chocolate whey": S, "chocolate milk": D },
    serves: "chocolate whey",
  },
  {
    // Fat-level variants of what she typed, and a different food that only
    // shares the word. Not the prompt's own word-order example.
    id: "milk-variants", typed: "milk",
    rows: { "toned milk": SU, "skimmed milk": SU, "milk cake": D },
  },
  {
    id: "word-order", typed: "butter chicken",
    rows: { "chicken butter masala": SU, "chicken with butter": SU, "peanut butter": D },
  },
  {
    // Fried changes the food enough that "different" is the safe answer too.
    id: "preparation", typed: "chicken breast",
    rows: { "fried chicken breast": ["same", "unclear", "different"], "raw chicken breast": SU, "chicken curry": D },
  },
  {
    id: "raw-vs-cooked", typed: "raw chicken breast",
    rows: { "cooked chicken breast": D, "grilled chicken breast": D, "raw chicken breast": S },
    serves: "raw chicken breast",
  },
  {
    id: "vague", typed: "shake",
    rows: { "protein shake": UD.concat("same"), "banana shake": UD.concat("same") },
  },
  {
    id: "dish-vs-ingredient", typed: "paneer",
    rows: { "Milky Mist high protein low fat paneer": S, "paneer tikka": D },
  },
  {
    id: "oats", typed: "oats",
    rows: { "rolled oats": S, "Doctor's Choice banana caramel protein oats": SU, "oat milk": D },
  },
];

// ── The old question (main before 2026-10-11), for comparison ───────────────

const OLD_LEVELS = [
  "Different food or an explicitly conflicting brand, flavour, preparation, or variant.",
  "Unresolved: more than one remembered product fits the shorthand, or the identity is unclear.",
  "The same remembered product, including unique compatible shorthand or omitted descriptors. No explicit detail conflicts and no other remembered product equally fits.",
];
const OLD_RULE =
  "Resolve the user's shorthand against ONLY this user's remembered foods in remembered_foods. " +
  "The candidate is a food this user previously accepted. Judge intended identity, not exact wording. " +
  "Missing words such as protein, product-line words, or full brand spelling are unspecified, not contradictory. " +
  "Punctuation, possessives, abbreviation and obvious spelling errors may be shorthand. " +
  "A partial brand may identify its unique compatible remembered brand. " +
  "The core food or ingredient must be the same. Different ingredients or plant species are different foods even when both are seeds, nuts, grains or milk. " +
  "Every explicitly named flavour, brand, preparation, fat level, and other variant must agree. " +
  "An explicit different flavour/brand or raw versus cooked is a conflict. " +
  "If multiple remembered products fit the stated details, choose unresolved for each, unless this user has a confirmed alias that uniquely identifies one. " +
  "Do not invent aliases and do not prefer protein products merely because the user logged them. " +
  "Other brands/flavours in the list do not create ambiguity when they conflict with explicit input details. " +
  "Quantities do not affect food identity. Score the specified candidate using the ordered criteria.";

// ── Running ─────────────────────────────────────────────────────────────────

function key(): string {
  const fromEnv = Deno.env.get("JEV_API_KEY");
  if (fromEnv) return fromEnv;
  for (const path of [".env.local", "../../.env.local"]) {
    try {
      const line = Deno.readTextFileSync(path).split("\n").find((l) => l.startsWith("JEV_API_KEY="));
      if (line) return line.slice("JEV_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
    } catch { /* try the next */ }
  }
  throw new Error("JEV_API_KEY not found");
}

const food = (name: string, times = 1): MemoryFood => ({
  key: name.toLowerCase(), name, food_id: null,
  per100: { kcal: 100, protein_g: 10, carb_g: 10, fat_g: 2, fiber_g: null },
  serving: null, source: "catalog", level: "precise", trust: 3, times,
  last_logged_at: "2026-10-01T00:00:00Z",
});

const LEVELS: Level[] = ["different", "unclear", "same"];
const pct = (n: number) => `${Math.round(n * 100)}`.padStart(3);

async function run(c: Case, apiKey: string, old: boolean) {
  const names = Object.keys(c.rows);
  const line = { name: c.typed, brand: null };
  const questions: Record<string, JevQuestion> = old
    ? Object.fromEntries(names.map((n, i) => [`m${i + 1}`, {
      type: "score", criteria: OLD_LEVELS,
      instructions: OLD_RULE + ` Input food: ${c.typed}. Candidate previously logged by this user: ${n}.`,
    }]))
    : memoryQuestions(line, names.map((n) => food(n)));
  const state = old
    ? { foods: [{ id: "f1", name: c.typed, brand: null }], remembered_foods: names.map((n, i) => ({ id: `m${i + 1}`, name: n, confirmed_aliases: [] })) }
    : { foods: [{ id: "f1", name: c.typed, brand: null }] };
  const res = await askJev(state, questions, { apiKey, timeoutMs: 15000 });
  if (!res.ok) return { c, error: `${res.failure} ${res.detail}` };
  const rows = names.map((n, i) => {
    const p = (res.response.answers[`m${i + 1}`] as { probabilities?: Record<string, number> })?.probabilities ?? {};
    const ch = { different: p["0"] ?? 0, unclear: p["1"] ?? 0, same: p["2"] ?? 0 };
    const top = LEVELS.reduce((a, b) => (ch[b] > ch[a] ? b : a));
    return { name: n, ch, top, ok: c.rows[n].includes(top) };
  });
  const foods = names.map((n) => food(n, c.times?.[n] ?? 1));
  const d = decideMemory(foods, rows.map((r) => r.ch.same));
  return { c, rows, served: d.food?.name ?? null, also: d.food?.also ?? [] };
}

const apiKey = key();
const withOld = Deno.env.get("OLD") === "1";
let rowsOk = 0, rowsAll = 0, servesOk = 0, servesAll = 0;
for (const c of CASES) {
  const r = await run(c, apiKey, false);
  if ("error" in r) { console.log(`ERROR ${c.id}: ${r.error}`); continue; }
  console.log(`\n${c.real ? "[real] " : ""}${c.id}: typed "${c.typed}"`);
  console.log("   diff unc same  answer      expected");
  for (const row of r.rows!) {
    rowsAll++; if (row.ok) rowsOk++;
    console.log(` ${row.ok ? " " : "X"} ${pct(row.ch.different)}  ${pct(row.ch.unclear)}  ${pct(row.ch.same)}  ${row.top.padEnd(10)}  ${c.rows[row.name].join("|").padEnd(15)} ${row.name}`);
  }
  let servedLine = `   serves: ${r.served ?? "none (normal lookup)"}${r.also!.length ? `  (also: ${r.also!.join(", ")})` : ""}`;
  if (c.serves !== undefined) {
    servesAll++;
    const good = r.served === c.serves;
    if (good) servesOk++;
    servedLine += good ? "" : `   X expected ${c.serves ?? "none"}`;
  }
  console.log(servedLine);
  if (withOld && c.real) {
    const o = await run(c, apiKey, true);
    if (!("error" in o)) {
      const unresolved = o.rows!.filter((x) => x.ch.unclear >= 0.75).length;
      console.log(`   OLD question: same=${o.rows!.map((x) => pct(x.ch.same).trim()).join("/")}  unresolved>=0.75 on ${unresolved} row(s)${unresolved > 1 ? " -> meal BLOCKED" : ""}`);
    }
  }
}
console.log(`\nrows answered as expected: ${rowsOk}/${rowsAll}`);
console.log(`foods served as expected:  ${servesOk}/${servesAll}`);
