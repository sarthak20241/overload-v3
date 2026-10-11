// Thorough: is the catalog row the food the user named?
//
// Thorough searches the catalog and lets the decide call pick a row. The
// ranker (rerank.ts) orders rows by how alike the NAMES read, and decide takes
// one "if it is acceptable", so a row that only shares a word with the food
// could be logged with full confidence: toast as Melba toast, chicken as
// chicken feet.
//
// This asks Jev the same question Precise asks before paying for the web
// (ourSources.ts): is any of these rows exactly this food? Same questions, same
// code gate, so one measured policy decides in both tiers. What differs is the
// answer to "no": Precise goes to the web, Thorough has the model estimate
// (owner decision 2026-10-11). The rows are the ones Thorough already fetched,
// so there is no second search.
//
//   Jev accepts a row      -> decide sees only that row
//   Jev says no row is it  -> decide sees no rows, and estimates
//   Jev failed or timed out -> nothing changes (fail open)
//
// Runtime-agnostic (no Deno globals) so the eval drives this exact file.

import type { JevDeps } from "./jev.ts";
import { matchOurSources } from "./ourSources.ts";
import type { MatchCandidate } from "./preciseMatch.ts";
import type { CandidateFood, ResolvedItem } from "./parseMeal.ts";

export type ThoroughMatchMode = "off" | "shadow" | "on";

/** Gate reasons that mean Jev judged the rows and none may be served. Every
 *  other reason is a failure to judge (no answer, a timeout, a throw), and a
 *  failure must never cost the user rows they would have had without this. */
const JUDGED_NO = new Set<string>([
  "none",
  "below_floor",
  "brand",
  "kind",
  "uncorroborated",
  "contested",
]);

export type ThoroughAction = "serve" | "estimate" | "keep";

export interface ThoroughJudgement {
  action: ThoroughAction;
  /** The one row decide may use, when action is "serve". */
  candidate: CandidateFood | null;
  trace: Record<string, unknown>;
}

/** What Jev reads as the food: the prep goes with the name, because "boiled"
 *  and "raw" are different foods to the plain-food rule. */
export function matchName(item: Pick<ResolvedItem, "name" | "prep">): string {
  const prep = item.prep?.trim();
  return prep && !item.name.toLowerCase().includes(prep.toLowerCase()) ? `${prep} ${item.name}` : item.name;
}

/** The gate reads a row's real origin (usda, curated, off...), not the coarse
 *  CandidateFood.source, because "plain food takes only a reference row" is
 *  the rule that refuses a branded or crowd-typed row for an apple. */
export function candidateMeta(c: CandidateFood, i: number, sourceOf: Map<string, string>): MatchCandidate {
  return {
    id: c.food_id ?? `row${i}`,
    name: c.name,
    brand: c.brand,
    source: c.food_id ? (sourceOf.get(c.food_id) ?? c.source) : c.source,
    kcal: c.kcal,
    protein_g: c.protein_g,
  };
}

export async function judgeThorough(
  jev: JevDeps,
  item: ResolvedItem,
  sourceOf: Map<string, string>,
  log?: (msg: string) => void,
): Promise<ThoroughJudgement> {
  const rows = item.candidates.map((c, i) => ({ food: c, meta: candidateMeta(c, i, sourceOf) }));
  const r = await matchOurSources(
    { jev, findCandidates: () => Promise.resolve(rows), log },
    { name: matchName(item), brand: item.brand ?? null },
  );
  if (r.match) return { action: "serve", candidate: r.match.food, trace: r.trace };
  const reason = (r.trace.decision as { reason?: string } | undefined)?.reason;
  // A reply with no scores in it is Jev not answering, even though the gate
  // reads it as every row below the floor.
  const scored = (r.trace.rows as Array<{ score: number | null }> | undefined)?.some((x) => x.score !== null) ?? false;
  const judged = typeof reason === "string" && JUDGED_NO.has(reason) && (reason !== "below_floor" || scored);
  return { action: judged ? "estimate" : "keep", candidate: null, trace: r.trace };
}

/** The item decide will see after the judgement, in "on" mode. */
export function applyJudgement(item: ResolvedItem, j: ThoroughJudgement): ResolvedItem {
  if (j.action === "serve" && j.candidate) return { ...item, candidates: [j.candidate] };
  if (j.action === "estimate") return { ...item, candidates: [] };
  return item;
}
