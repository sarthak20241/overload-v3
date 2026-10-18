// Which free-tier requests may ask for the one free "Build phase 1".
//
// Plan generation is Pro. The single exception is a plain forced
// generate_plan that names a phase: that is the Goal & Plan screen building a
// phase split. Refine and discuss send a `mode` and stay Pro, as does any
// other forced tool. This only decides whether to ASK; the
// try_claim_free_phase_build RPC decides whether it is phase 1 and unspent.
export function freePhaseBuildCandidate(body: unknown): string | null {
  const b = (body ?? {}) as { mode?: unknown; force_tool?: unknown; phase_id?: unknown };
  if (b.force_tool !== "generate_plan") return null;
  if (b.mode !== undefined) return null;
  if (typeof b.phase_id !== "string" || b.phase_id === "") return null;
  return b.phase_id;
}
