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

// Which free-tier requests may ask for a free refine turn on that build.
//
// The app builds phase 1 as an unsaved draft and lets the user talk it over
// with Drona before Save. That chat is RefineChatScreen in mode 'refine_plan';
// its "yes, do it" turn also forces generate_plan so the model re-emits the
// plan. Both must pass, or the turn that applies the change would hit the
// paywall. Discuss modes (no draft yet) and any other forced tool stay Pro.
// This only decides whether to ASK; try_claim_free_phase_refine decides
// whether this phase is the claimed, still-unsaved build with turns left.
export function freePhaseRefineCandidate(body: unknown): string | null {
  const b = (body ?? {}) as { mode?: unknown; force_tool?: unknown; phase_id?: unknown };
  if (b.mode !== "refine_plan") return null;
  if (b.force_tool !== undefined && b.force_tool !== "generate_plan") return null;
  if (typeof b.phase_id !== "string" || b.phase_id === "") return null;
  return b.phase_id;
}
