// Precise, our sources first: before paying for a web lookup, ask whether a
// row we already hold IS this food.
//
//   1. search our catalog (the caller's findCandidates)   ┐ in parallel
//      Jev question 1: what kind of food                   ┘
//   2. Jev: score every candidate row on its own (preciseMatch.ts)
//   3. only when the top rows disagree on numbers: one side-by-side
//      multiple-choice tie-break over just those rows
//   4. the code gate in preciseMatch.ts decides what, if anything, is served
//
// Measured before wiring (scripts/precise-match, 41 labelled lines, two runs):
// 28-29 served right, 0 wrong. Runs behind PRECISE_MATCH_MODE: "shadow" does
// all of this and only RECORDS what it would have served; "on" serves it.
//
// Never throws, and a Jev failure is simply "no match": the web lookup then
// runs exactly as it would have without this.
//
// Runtime-agnostic (no Deno globals): parseMeal imports it, the eval can too.

import { askJev, asChoice, type JevDeps } from "./jev.ts";
import {
  decideKind,
  decideScoreStage,
  decideTiebreak,
  type FoodKind,
  kindQuestion,
  type MatchCandidate,
  type MatchDecision,
  type MatchItem,
  matchScoreQuestions,
  mealState,
  tiebreakQuestion,
} from "./preciseMatch.ts";

export interface OurSourcesDeps<F> {
  jev: JevDeps;
  /** Candidate rows for this line, each with the full row to serve (`food`)
   *  and the fields Jev and the gate read (`meta`). */
  findCandidates(item: MatchItem): Promise<Array<{ food: F; meta: MatchCandidate }>>;
  log?: (msg: string) => void;
}

export interface OurSourcesResult<F> {
  match: { food: F; meta: MatchCandidate; confidence: number } | null;
  /** What happened, for the parse trace. Small on purpose: names, sources,
   *  kcal and Jev's scores, never full rows. */
  trace: Record<string, unknown>;
}

/** How many rows production search keeps (searchCatalogWithServings), and how
 *  many extra lab / curated rows may join them from further down. The extras
 *  exist because a generic line is easily crowded out by branded packs: the
 *  eval's "rolled oats" came back as eight OFF brands and no generic row, so
 *  there was nothing a plain food was allowed to take. */
export const MAIN_ROWS = 8;
export const EXTRA_REFERENCE_ROWS = 4;
const EXTRA_SOURCES = new Set(["usda", "cofid", "ciqual", "curated", "web_verified"]);

/**
 * Which search rows Jev sees, in order: Precise cache rows first (foods we
 * researched on the web before; migration 0141's precise_cache_candidates),
 * then production's own merge (trigram rows, then semantic rows not already
 * in), capped at MAIN_ROWS, then up to EXTRA_REFERENCE_ROWS lab or curated rows
 * that ranked lower. Pure, by id.
 */
export function selectMatchRows<R extends { id: string }>(
  trigram: R[],
  semantic: R[],
  sourceOf: (id: string) => string | undefined,
  cached: R[] = [],
): R[] {
  const seen = new Set<string>();
  const ordered: R[] = [];
  for (const r of [...cached, ...trigram, ...semantic]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    ordered.push(r);
  }
  const main = ordered.slice(0, MAIN_ROWS);
  const extras = ordered.slice(MAIN_ROWS)
    .filter((r) => EXTRA_SOURCES.has(sourceOf(r.id) ?? ""))
    .slice(0, EXTRA_REFERENCE_ROWS);
  return [...main, ...extras];
}

const KEY = "f1";
const round2 = (n: number | null | undefined) => (typeof n === "number" ? Math.round(n * 100) / 100 : null);

/** Kind unknown (Jev unsure or down) is judged by the packaged rule: a row must
 *  carry the line's brand, and a plain reference row never answers. So an
 *  unsure kind can cost a web lookup, never serve the wrong row. */
const FALLBACK_KIND: FoodKind = "packaged";

export async function matchOurSources<F>(deps: OurSourcesDeps<F>, item: MatchItem): Promise<OurSourcesResult<F>> {
  const trace: Record<string, unknown> = { item: item.name, brand: item.brand };
  try {
    const state = mealState([item]);
    const [kindRes, found] = await Promise.all([
      askJev(state, { [`${KEY}_kind`]: kindQuestion(KEY) }, deps.jev).catch(() => null),
      deps.findCandidates(item).catch((e) => {
        deps.log?.(`[our_sources] candidate search failed: ${String(e).slice(0, 120)}`);
        return [] as Array<{ food: F; meta: MatchCandidate }>;
      }),
    ]);
    const kindAnswer = kindRes?.ok ? asChoice(kindRes.response.answers[`${KEY}_kind`]) : null;
    const kind = decideKind(kindAnswer);
    trace.kind = kind;
    trace.kind_answer = kindAnswer ? { choice: kindAnswer.choice, conf: round2(kindAnswer.confidence) } : null;
    trace.candidates = found.length;
    if (found.length === 0) {
      trace.decision = { match: null, reason: "no_candidates" };
      return { match: null, trace };
    }

    const cands = found.map((f) => f.meta);
    const ruleKind = kind ?? FALLBACK_KIND;
    const scoreRes = await askJev(state, matchScoreQuestions(KEY, ruleKind, cands), deps.jev).catch(() => null);
    if (!scoreRes?.ok) {
      trace.decision = { match: null, reason: scoreRes ? `jev_${scoreRes.failure}` : "jev_threw" };
      return { match: null, trace };
    }
    const scores = cands.map((_, i) => {
      const a = scoreRes.response.answers[`${KEY}_c${i + 1}`] as { type?: string; probabilities?: Record<string, number> } | undefined;
      return a?.type === "score" ? (a.probabilities?.["2"] ?? 0) : null;
    });
    trace.rows = cands.map((c, i) => ({ name: c.name.slice(0, 60), source: c.source, kcal: c.kcal ?? null, score: round2(scores[i]) }));

    let decision: MatchDecision;
    const stage = decideScoreStage(ruleKind, item, cands, scores);
    if ("decision" in stage) {
      decision = stage.decision;
    } else {
      const tieRes = await askJev(state, { [`${KEY}_tie`]: tiebreakQuestion(KEY, ruleKind, stage.tiebreak) }, deps.jev)
        .catch(() => null);
      const tie = tieRes?.ok ? asChoice(tieRes.response.answers[`${KEY}_tie`]) : null;
      trace.tiebreak = {
        rows: stage.tiebreak.map((c) => `${c.name.slice(0, 40)} ${c.kcal ?? "?"}`),
        answer: tie ? { choice: tie.choice, conf: round2(tie.confidence) } : null,
      };
      decision = decideTiebreak(ruleKind, item, cands, stage.tiebreak, scores, tie);
    }

    if (!decision.match) {
      trace.decision = { match: null, reason: decision.reason, conf: round2(decision.confidence) };
      return { match: null, trace };
    }
    const served = found.find((f) => f.meta.id === decision.match!.id)!;
    trace.decision = {
      match: decision.match.name.slice(0, 60),
      source: decision.match.source,
      kcal: decision.match.kcal ?? null,
      conf: round2(decision.confidence),
    };
    return { match: { food: served.food, meta: served.meta, confidence: decision.confidence }, trace };
  } catch (e) {
    trace.decision = { match: null, reason: "threw", detail: String(e).slice(0, 120) };
    return { match: null, trace };
  }
}

