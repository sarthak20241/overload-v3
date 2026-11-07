// The first-message gate (FOOD_FIRST_GATE), measured on its own.
//
//   npx tsx scripts/food-box-eval/gate-probe.mts          # RUNS=3  HELD_OUT=1
//
// Asks the router's Jev call, with the gate question in it (routeFoodIntent,
// askPlain), on every first-message case, and prints Jev's "fully plain log"
// score beside the case's right answer (cases.ts FIRST_MESSAGE_PLAIN). Jev
// only: no Claude call, so no CLI rule applies. Needs JEV_API_KEY.
//
// The floor (foodIntent.ts PLAIN_LOG_FLOOR) is picked from this: it must sit
// above every non-plain score, so no message that asks for anything takes the
// parse path. The plain logs under it go to the agent, and their share is the
// cost of the floor.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { CASES, isFirstMessage } from "./cases.ts";
import { PLAIN_LOG_FLOOR, routeFoodIntent } from "../../supabase/functions/ai-coach/foodIntent.ts";

function envFile(): Record<string, string> {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  for (const p of [".env.local", `${common.replace(/\/\.git$/, "")}/.env.local`]) {
    try {
      const out: Record<string, string> = {};
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      return out;
    } catch { /* next */ }
  }
  return {};
}
const key = process.env.JEV_API_KEY ?? envFile().JEV_API_KEY;
if (!key) {
  console.error("JEV_API_KEY is not set (env or .env.local).");
  process.exit(1);
}
const RUNS = Math.max(1, Number(process.env.RUNS ?? "3") || 3);

/** Held out: written AFTER the gate wording was last changed (2026-11-07),
 *  never used to tune it, and not food box eval cases. They check the floor on
 *  messages the wording was not fitted to. */
const HELD_OUT: { id: string; message: string; plain: boolean }[] = [
  { id: "ho-plain-1", message: "bowl of oats with milk and a spoon of peanut butter", plain: true },
  { id: "ho-plain-2", message: "chicken biryani, one plate, and a raita", plain: true },
  { id: "ho-plain-3", message: "Greek yogurt 170g, 0% fat, plus a handful of blueberries", plain: true },
  { id: "ho-plain-4", message: "dinner: 2 dosa with sambar and coconut chutney", plain: true },
  { id: "ho-plain-5", message: "1 Quest bar cookies and cream, 190 cal 21g protein", plain: true },
  { id: "ho-plain-6", message: "thanks! also had an apple", plain: true },
  { id: "ho-other-1", message: "is 3 eggs a day too many?", plain: false },
  { id: "ho-other-2", message: "log my usual breakfast from monday", plain: false },
  { id: "ho-other-3", message: "a cappuccino, did you count the sugar last time?", plain: false },
  { id: "ho-other-4", message: "remember this as my lunch box: rice, dal, 1 roti", plain: false },
  { id: "ho-other-5", message: "two parathas and the same curd as this morning", plain: false },
  { id: "ho-other-6", message: "how many calories left for today", plain: false },
  { id: "ho-other-7", message: "had a burger, can you remove the fries I added earlier", plain: false },
];

const HELD = process.env.HELD_OUT === "1";
const first = HELD
  ? HELD_OUT.map((h) => ({ id: h.id, message: h.message, plain: h.plain, fixtures: undefined } as unknown as (typeof CASES)[number]))
  : CASES.filter(isFirstMessage);
const missing = first.filter((c) => c.plain === undefined).map((c) => c.id);
if (missing.length) {
  console.error(`First-message cases with no gate label: ${missing.join(", ")}`);
  process.exit(1);
}

const rows = await Promise.all(first.map(async (c) => {
  const saved = (c.fixtures?.savedMeals ?? []).map((m, i) => ({ id: `saved-${i}`, name: m.name, kcal: m.kcal, protein_g: m.protein_g }));
  const scores: (number | null)[] = [];
  let intent = "";
  for (let r = 0; r < RUNS; r++) {
    const d = await routeFoodIntent(c.message, { savedMeals: saved, jev: { apiKey: key, timeoutMs: 8000 }, askPlain: true }, {
      recentTurns: [],
      pendingMeal: null,
      card: null,
    });
    scores.push(d.plainLog ?? null);
    intent = `${d.intent}@${d.confidence?.toFixed(2) ?? "-"}`;
  }
  return { c, scores, intent };
}));

const fmt = (n: number | null) => (n === null ? " null" : n.toFixed(3));
console.log(`Gate probe: ${first.length} first messages x ${RUNS} runs. Floor now ${PLAIN_LOG_FLOOR}.\n`);
console.log("label  min    max    intent          case");
for (const { c, scores, intent } of rows.sort((a, b) => Number(a.c.plain) - Number(b.c.plain) || a.c.id.localeCompare(b.c.id))) {
  const ok = scores.filter((s): s is number => s !== null);
  console.log(`${c.plain ? "plain" : "other"}  ${fmt(ok.length ? Math.min(...ok) : null)}  ${fmt(ok.length ? Math.max(...ok) : null)}  ${intent.padEnd(14)}  ${c.id}`);
}
// A null is a Jev call that did not answer: counted on its own, never as a
// score of 0, so an outage cannot hide inside "plain logs sent to the agent".
const nulls = rows.reduce((n, r) => n + r.scores.filter((s) => s === null).length, 0);
if (nulls) console.warn(`\nWARNING: ${nulls} Jev call(s) gave no answer. Those runs are left out of the numbers below.`);
const otherScores = rows.filter((r) => !r.c.plain).flatMap((r) => r.scores.filter((s): s is number => s !== null));
const plainRows = rows.filter((r) => r.c.plain).map((r) => r.scores.filter((s): s is number => s !== null)).filter((xs) => xs.length > 0);
const plainMins = plainRows.map((xs) => Math.min(...xs));
console.log(
  otherScores.length
    ? `\nHighest non-plain score: ${Math.max(...otherScores).toFixed(3)}. Any floor above it gives zero false plains.`
    : "\nNo non-plain message has a score, so false plains cannot be measured.",
);
for (const f of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  const falsePlain = rows.filter((r) => !r.c.plain && r.scores.some((s) => s !== null && s >= f)).length;
  const toAgent = plainMins.filter((m) => m < f).length;
  console.log(`  floor ${f.toFixed(2)}: false plains ${falsePlain}, plain logs sent to the agent ${toAgent}/${plainMins.length}`);
}
