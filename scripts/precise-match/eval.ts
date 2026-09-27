// Precise match eval: Jev's two questions against labelled lines.
//
//   deno run --allow-all scripts/precise-match/eval.ts            # both groups
//   GROUP=tune deno run --allow-all scripts/precise-match/eval.ts
//   ONLY=kind|match deno run --allow-all scripts/precise-match/eval.ts
//
// Costs Jev only (fractions of a cent a run); no Anthropic credit. Reads
// JEV_API_KEY from .env.local.
//
// What counts, in order of how much it matters:
//   1. FALSE MATCH: the gate served a row that is not this food. Must be zero
//      on FRESH at the chosen floor; this is a wrong number with a confident
//      badge on someone's diary.
//   2. MISS: an acceptable row existed and nothing was served. Costs one web
//      lookup, never correctness.
//   3. Kind answered wrongly AND confidently: can steer question 2 wrong.
//
// The match run gives Jev the LABELLED kind, so it measures question 2 alone;
// kind mistakes are reported by the kind run. Batches mimic a meal: several
// foods per request, which is how production asks.

import { askJev, asChoice, type JevQuestion } from "../../supabase/functions/ai-coach/jev.ts";
import {
  decideKind,
  decideMatch,
  foodKey,
  kindQuestion,
  type MatchCandidate,
  matchQuestion,
  mealState,
} from "../../supabase/functions/ai-coach/preciseMatch.ts";
import { KIND_CASES } from "./kindCases.ts";
import { MATCH_LABELS } from "./matchLabels.ts";
import { QUERIES } from "./queries.ts";

const env: Record<string, string> = {};
for (const line of Deno.readTextFileSync(".env.local").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const jev = { apiKey: Deno.env.get("JEV_API_KEY") ?? env.JEV_API_KEY ?? "", timeoutMs: 20000 };
if (!jev.apiKey) {
  console.error("JEV_API_KEY is not set.");
  Deno.exit(1);
}
const GROUP = Deno.env.get("GROUP");
const ONLY = Deno.env.get("ONLY");
const groups = (GROUP ? [GROUP] : ["tune", "fresh"]) as Array<"tune" | "fresh">;
const FLOORS = [0.6, 0.7, 0.75, 0.8, 0.9];
const BATCH = 5;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ── Kind ────────────────────────────────────────────────────────────────────
async function runKind(group: "tune" | "fresh") {
  const cases = KIND_CASES.filter((c) => c.group === group);
  const answers: Array<{ c: (typeof cases)[number]; choice: string | null; conf: number }> = [];
  for (const batch of chunks(cases, BATCH)) {
    const questions: Record<string, JevQuestion> = {};
    batch.forEach((_, i) => { questions[`${foodKey(i)}_kind`] = kindQuestion(foodKey(i)); });
    const res = await askJev(mealState(batch), questions, jev);
    batch.forEach((c, i) => {
      const a = res.ok ? asChoice(res.response.answers[`${foodKey(i)}_kind`]) : null;
      answers.push({ c, choice: a?.choice ?? null, conf: a?.confidence ?? 0 });
    });
    if (!res.ok) console.error(`  jev failed: ${res.failure} ${res.detail}`);
  }
  console.log(`\n── KIND (${group}, ${cases.length}) ──`);
  for (const f of [0.5, 0.6, 0.7]) {
    const right = answers.filter((a) => a.conf >= f && a.choice && a.c.ok.includes(a.choice as never)).length;
    const wrong = answers.filter((a) => a.conf >= f && a.choice && !a.c.ok.includes(a.choice as never)).length;
    const unsure = answers.length - right - wrong;
    console.log(`floor ${f}: right ${right}  WRONG ${wrong}  unsure ${unsure}`);
  }
  for (const a of answers) {
    const ok = a.choice && a.c.ok.includes(a.choice as never);
    if (!ok || a.conf < 0.7) {
      console.log(`  ${ok ? "low " : "MISS"} ${a.c.name}${a.c.brand ? ` [${a.c.brand}]` : ""}: ${a.choice} @ ${a.conf.toFixed(2)} (want ${a.c.ok.join("/")})`);
    }
  }
  return answers.map((a) => ({ ...a, kind: decideKind(a.choice ? { type: "choice", choice: a.choice, confidence: a.conf, probabilities: {} } : null) }));
}

// ── Match ───────────────────────────────────────────────────────────────────
const CANDIDATES: Record<string, MatchCandidate[]> = JSON.parse(
  Deno.readTextFileSync("scripts/precise-match/candidates.json"),
);

async function runMatch(group: "tune" | "fresh") {
  const qs = QUERIES.filter((q) => q.group === group && MATCH_LABELS[q.id]);
  const results: Array<{ id: string; line: string; answer: ReturnType<typeof asChoice>; cands: MatchCandidate[] }> = [];
  for (const batch of chunks(qs, BATCH)) {
    const questions: Record<string, JevQuestion> = {};
    batch.forEach((q, i) => {
      questions[`${foodKey(i)}_match`] = matchQuestion(foodKey(i), MATCH_LABELS[q.id].kind, CANDIDATES[q.id] ?? []);
    });
    const res = await askJev(mealState(batch), questions, jev);
    if (!res.ok) console.error(`  jev failed: ${res.failure} ${res.detail}`);
    batch.forEach((q, i) => {
      results.push({
        id: q.id,
        line: `${q.brand ? `${q.brand} | ` : ""}${q.name}`,
        answer: res.ok ? asChoice(res.response.answers[`${foodKey(i)}_match`]) : null,
        cands: CANDIDATES[q.id] ?? [],
      });
    });
  }

  console.log(`\n── MATCH (${group}, ${results.length}) ──`);
  for (const floor of FLOORS) {
    let right = 0, falseM = 0, miss = 0, rightNone = 0;
    for (const r of results) {
      const label = MATCH_LABELS[r.id];
      const q = QUERIES.find((x) => x.id === r.id)!;
      const d = decideMatch(label.kind, { name: q.name, brand: q.brand }, r.cands, r.answer, floor);
      const anyOk = label.ok.length > 0;
      if (d.match) {
        if (label.ok.includes(d.match.id)) right++;
        else falseM++;
      } else if (anyOk) miss++;
      else rightNone++;
    }
    console.log(`floor ${floor}: served-right ${right}  FALSE ${falseM}  miss ${miss}  right-none ${rightNone}`);
  }
  console.log("detail at the default floor (0.75):");
  for (const r of results) {
    const label = MATCH_LABELS[r.id];
    const q = QUERIES.find((x) => x.id === r.id)!;
    const d = decideMatch(label.kind, { name: q.name, brand: q.brand }, r.cands, r.answer);
    const picked = r.answer?.choice?.startsWith("c") ? r.cands[Number(r.answer.choice.slice(1)) - 1] : null;
    const verdict = d.match
      ? (label.ok.includes(d.match.id) ? "ok  " : "FALSE")
      : (label.ok.length ? "miss" : "ok  ");
    const why = d.match ? ` served "${d.match.name}"` : ` (${d.reason})`;
    const top3 = Object.entries(r.answer?.probabilities ?? {})
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
    console.log(
      `  ${verdict} ${r.id.padEnd(18)} ${r.line.padEnd(34)} -> ${r.answer?.choice ?? "-"} @ ${(r.answer?.confidence ?? 0).toFixed(2)}` +
        `${picked ? ` "${picked.name}"${picked.brand ? ` [${picked.brand}]` : ""} ${picked.source}` : ""}${why}` +
        `  | group ${d.confidence.toFixed(2)} | ${top3}`,
    );
  }
}

for (const g of groups) {
  if (ONLY !== "match") await runKind(g);
  if (ONLY !== "kind") await runMatch(g);
}
