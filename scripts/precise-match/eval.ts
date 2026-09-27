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

import { askJev, asChoice, asNoul, type JevChoiceAnswer, type JevQuestion } from "../../supabase/functions/ai-coach/jev.ts";
import {
  decideKind,
  decideMatch,
  decideMatchNoul,
  decideScoreStage,
  decideTiebreak,
  foodKey,
  kindQuestion,
  type MatchCandidate,
  matchNoulQuestions,
  matchQuestion,
  matchScoreQuestions,
  tiebreakQuestion,
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
// DUMP=path writes every answer in full (question, options, probabilities,
// decision) for reading outside the terminal.
const DUMP = Deno.env.get("DUMP");
// MATCH_MODE=noul asks one yes/no per candidate row instead of one choice.
const MODE = Deno.env.get("MATCH_MODE") ?? "choice";
// Both per-row forms (yes/no and graded score) share the per-row gate.
const NOUL = MODE === "noul" || MODE === "score" || MODE === "tiebreak";
// tiebreak: score each row (stage 1), then one side-by-side choice for foods
// whose top rows disagree on numbers (stage 2). Owner's choice B.
const TIEBREAK = MODE === "tiebreak";
const dump: { kind: unknown[]; match: unknown[] } = { kind: [], match: [] };
// A failed Jev request would otherwise read as a string of misses. Any failure
// makes the whole run invalid: it is reported and the process exits non-zero.
const jevFailures: string[] = [];

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ── Kind ────────────────────────────────────────────────────────────────────
async function runKind(group: "tune" | "fresh") {
  const cases = KIND_CASES.filter((c) => c.group === group);
  const answers: Array<{ c: (typeof cases)[number]; choice: string | null; conf: number; probs: Record<string, number> }> = [];
  for (const batch of chunks(cases, BATCH)) {
    const questions: Record<string, JevQuestion> = {};
    batch.forEach((_, i) => { questions[`${foodKey(i)}_kind`] = kindQuestion(foodKey(i)); });
    const res = await askJev(mealState(batch), questions, jev);
    batch.forEach((c, i) => {
      const a = res.ok ? asChoice(res.response.answers[`${foodKey(i)}_kind`]) : null;
      answers.push({ c, choice: a?.choice ?? null, conf: a?.confidence ?? 0, probs: a?.probabilities ?? {} });
    });
    if (!res.ok) jevFailures.push(`kind: ${res.failure} ${res.detail}`);
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
  for (const a of answers) {
    dump.kind.push({
      group, name: a.c.name, brand: a.c.brand, ok: a.c.ok, choice: a.choice, confidence: a.conf,
      probabilities: a.probs, decided: decideKind(a.choice ? { type: "choice", choice: a.choice, confidence: a.conf, probabilities: {} } : null),
    });
  }
  return answers.map((a) => ({ ...a, kind: decideKind(a.choice ? { type: "choice", choice: a.choice, confidence: a.conf, probabilities: {} } : null) }));
}

// ── Match ───────────────────────────────────────────────────────────────────

/** Per-row yes/no scores, carried in the same shape as a choice answer so the
 *  report code is shared: `probabilities` holds each row's own chance (they do
 *  NOT add up to 1), `choice` is the top row. */
function noulAsAnswer(answers: Record<string, unknown>, key: string, n: number): JevChoiceAnswer {
  const probs: Record<string, number> = {};
  for (let i = 1; i <= n; i++) {
    const a = answers[`${key}_c${i}`] as { type?: string; probabilities?: Record<string, number> } | undefined;
    // score: the chance of the top level ("exactly this food"); noul: the yes.
    probs[`c${i}`] = a?.type === "score" ? (a.probabilities?.["2"] ?? 0) : (asNoul(a as never) ?? 0);
  }
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
  return { type: "choice", choice: top[0], confidence: top[1], probabilities: probs };
}
function decideFor(
  r: { cands: MatchCandidate[]; answer: JevChoiceAnswer | null; tieRows?: MatchCandidate[]; tieAnswer?: JevChoiceAnswer | null },
  kind: Parameters<typeof decideMatch>[0],
  item: { name: string; brand: string | null },
  floor?: number,
) {
  if (!TIEBREAK) return decide(kind, item, r.cands, r.answer, floor);
  const scores = r.cands.map((_, i) => r.answer?.probabilities?.[`c${i + 1}`] ?? null);
  const st = decideScoreStage(kind, item, r.cands, scores, floor);
  if ("decision" in st) return st.decision;
  return decideTiebreak(kind, item, r.cands, st.tiebreak, scores, r.tieAnswer ?? null, floor);
}
const decide = (kind: Parameters<typeof decideMatch>[0], item: { name: string; brand: string | null }, cands: MatchCandidate[], a: JevChoiceAnswer | null, floor?: number) =>
  NOUL
    ? decideMatchNoul(kind, item, cands, cands.map((_, i) => a?.probabilities?.[`c${i + 1}`] ?? null), floor,
      Deno.env.get("CONTEST") === "off" ? -1 : undefined)
    : decideMatch(kind, item, cands, a, floor);
const CANDIDATES: Record<string, MatchCandidate[]> = JSON.parse(
  Deno.readTextFileSync("scripts/precise-match/candidates.json"),
);

async function runMatch(group: "tune" | "fresh") {
  const qs = QUERIES.filter((q) => q.group === group && MATCH_LABELS[q.id]);
  const results: Array<{
    id: string; line: string; answer: ReturnType<typeof asChoice>; cands: MatchCandidate[];
    tieRows?: MatchCandidate[]; tieAnswer?: JevChoiceAnswer | null;
  }> = [];
  for (const batch of chunks(qs, BATCH)) {
    const questions: Record<string, JevQuestion> = {};
    batch.forEach((q, i) => {
      if (MODE === "score" || TIEBREAK) Object.assign(questions, matchScoreQuestions(foodKey(i), MATCH_LABELS[q.id].kind, CANDIDATES[q.id] ?? []));
      else if (NOUL) Object.assign(questions, matchNoulQuestions(foodKey(i), MATCH_LABELS[q.id].kind, CANDIDATES[q.id] ?? []));
      else questions[`${foodKey(i)}_match`] = matchQuestion(foodKey(i), MATCH_LABELS[q.id].kind, CANDIDATES[q.id] ?? []);
    });
    const res = await askJev(mealState(batch), questions, jev);
    if (!res.ok) jevFailures.push(`match: ${res.failure} ${res.detail}`);
    batch.forEach((q, i) => {
      results.push({
        id: q.id,
        line: `${q.brand ? `${q.brand} | ` : ""}${q.name}`,
        answer: !res.ok ? null : NOUL ? noulAsAnswer(res.response.answers, foodKey(i), (CANDIDATES[q.id] ?? []).length)
          : asChoice(res.response.answers[`${foodKey(i)}_match`]),
        cands: CANDIDATES[q.id] ?? [],
      });
    });
  }

  if (TIEBREAK) {
    // Stage 2 for every food that needs one at the lowest floor tried; the tied
    // rows do not depend on the floor, only whether the best row reached it.
    const need = results
      .map((r) => {
        const label = MATCH_LABELS[r.id];
        const q = QUERIES.find((x) => x.id === r.id)!;
        const scores = r.cands.map((_, i) => r.answer?.probabilities?.[`c${i + 1}`] ?? null);
        const st = decideScoreStage(label.kind, { name: q.name, brand: q.brand }, r.cands, scores, Math.min(...FLOORS));
        return "tiebreak" in st ? { r, rows: st.tiebreak, kind: label.kind, q } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    for (const batch of chunks(need, BATCH)) {
      const questions: Record<string, JevQuestion> = {};
      batch.forEach((n, i) => { questions[`${foodKey(i)}_tie`] = tiebreakQuestion(foodKey(i), n.kind, n.rows); });
      const res = await askJev(mealState(batch.map((n) => n.q)), questions, jev);
      if (!res.ok) jevFailures.push(`tie-break: ${res.failure} ${res.detail}`);
      batch.forEach((n, i) => {
        n.r.tieRows = n.rows;
        n.r.tieAnswer = res.ok ? asChoice(res.response.answers[`${foodKey(i)}_tie`]) : null;
      });
    }
    console.log(`(tie-break asked for ${need.length} of ${results.length} foods)`);
  }

  console.log(`\n── MATCH ${TIEBREAK ? "score + tie-break" : MODE === "score" ? "per-row score" : NOUL ? "per-row yes/no" : "one choice"} (${group}, ${results.length}) ──`);
  for (const floor of FLOORS) {
    let right = 0, falseM = 0, miss = 0, rightNone = 0;
    for (const r of results) {
      const label = MATCH_LABELS[r.id];
      const q = QUERIES.find((x) => x.id === r.id)!;
      const d = decideFor(r, label.kind, { name: q.name, brand: q.brand }, floor);
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
    const d = decideFor(r, label.kind, { name: q.name, brand: q.brand });
    const picked = r.answer?.choice?.startsWith("c") ? r.cands[Number(r.answer.choice.slice(1)) - 1] : null;
    const verdict = d.match
      ? (label.ok.includes(d.match.id) ? "ok  " : "FALSE")
      : (label.ok.length ? "miss" : "ok  ");
    const why = d.match ? ` served "${d.match.name}"` : ` (${d.reason})`;
    const top3 = Object.entries(r.answer?.probabilities ?? {})
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
    dump.match.push({
      group, id: r.id, name: q.name, brand: q.brand, kind: label.kind,
      question: matchQuestion("f1", label.kind, r.cands),
      candidates: r.cands.map((c, i) => ({ key: `c${i + 1}`, ...c, ok: label.ok.includes(c.id) })),
      probabilities: r.answer?.probabilities ?? {}, choice: r.answer?.choice ?? null,
      served: d.match ? { id: d.match.id, name: d.match.name } : null,
      reason: d.match ? null : d.reason, group_confidence: d.confidence,
      verdict: verdict.trim(),
    });
    console.log(
      `  ${verdict} ${r.id.padEnd(18)} ${r.line.padEnd(34)} -> ${r.answer?.choice ?? "-"} @ ${(r.answer?.confidence ?? 0).toFixed(2)}` +
        `${picked ? ` "${picked.name}"${picked.brand ? ` [${picked.brand}]` : ""} ${picked.source}` : ""}${why}` +
        `  | group ${d.confidence.toFixed(2)} | ${top3}` +
        (r.tieRows ? `  | TIE [${r.tieRows.map((c) => `${c.name.slice(0, 28)} ${c.kcal}`).join(" / ")}] -> ` +
          `${r.tieAnswer?.choice ?? "-"} @ ${(r.tieAnswer?.confidence ?? 0).toFixed(2)}` : ""),
    );
  }
}

for (const g of groups) {
  if (ONLY !== "match") await runKind(g);
  if (ONLY !== "kind") await runMatch(g);
}
if (jevFailures.length) {
  console.error(`\nINVALID RUN: ${jevFailures.length} Jev request(s) failed, so the counts above are not a measurement:`);
  for (const f of jevFailures) console.error(`  ${f}`);
  Deno.exit(1);
}
if (DUMP) {
  Deno.writeTextFileSync(DUMP, JSON.stringify({ kindQuestion: kindQuestion("f1"), ...dump }, null, 2));
  console.log(`\nwrote ${DUMP}`);
}
