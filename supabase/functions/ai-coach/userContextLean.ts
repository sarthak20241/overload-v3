// Chat's short user summary, and the sections it holds back.
//
// The user_context block is written into the prompt cache again on every cold
// chat message (first message, or 5+ minutes since the last one). Measured
// 2026-10-29: the owner's block was 59k characters, 44k of them the full
// contents of 52 saved routines. Chat keeps who the user is (profile, goals,
// injuries, memory, targets, program, top lifts, recovery) and lists the big
// sections in on_request; coach_get_user_details reads them from the copy
// held here, with no database call.
//
// Runtime-agnostic, like memory.ts: no Deno globals.

export const ON_REQUEST_SECTIONS = ["routines", "weekly_volume", "plan_changes", "body_measurements"] as const;
export type OnRequestSection = typeof ON_REQUEST_SECTIONS[number];
export type HeldSections = Partial<Record<OnRequestSection, unknown>>;

/** Routine lists this long or shorter are sent whole. */
const ROUTINES_WHOLE_MAX = 3;
/** Routine names kept in the summary when the list is held back. */
const ROUTINE_NAMES_MAX = 15;
/** Plan changes kept in the summary; the rest wait. */
const PLAN_CHANGES_KEPT = 3;

type Ctx = Record<string, unknown>;

function exerciseCount(r: unknown): number {
  const ex = (r as { exercises?: unknown })?.exercises;
  return Array.isArray(ex) ? ex.length : 0;
}

/**
 * Split a full user_context into the summary chat sends and the sections it
 * holds back. The input is left untouched; other modes keep using it whole.
 */
export function leanUserContext(full: unknown): { summary: unknown; held: HeldSections } {
  if (!full || typeof full !== "object" || Array.isArray(full)) return { summary: full ?? null, held: {} };
  const summary: Ctx = { ...(full as Ctx) };
  const held: HeldSections = {};
  const on: Record<string, string> = {};

  // Routines arrive newest first (get_user_coach_context orders by created_at desc).
  const routines = summary.active_routines;
  if (Array.isArray(routines) && routines.length > ROUTINES_WHOLE_MAX) {
    held.routines = routines;
    summary.active_routines = routines.slice(0, ROUTINE_NAMES_MAX).map((r) => ({
      name: (r as { name?: unknown })?.name ?? null,
      exercises: exerciseCount(r),
    }));
    on.routines = `${routines.length} saved routines with every exercise, sets, reps and rest. ` +
      (routines.length > ROUTINE_NAMES_MAX
        ? `active_routines lists the newest ${ROUTINE_NAMES_MAX} by name only.`
        : "active_routines lists them by name only.");
  }

  const volume = summary.weekly_volume;
  if (Array.isArray(volume) && volume.length > 0) {
    held.weekly_volume = volume;
    delete summary.weekly_volume;
    on.weekly_volume = `${volume.length} rows of working sets per muscle per week.`;
  }

  const changes = summary.recent_plan_changes;
  if (Array.isArray(changes) && changes.length > PLAN_CHANGES_KEPT) {
    held.plan_changes = changes;
    summary.recent_plan_changes = changes.slice(0, PLAN_CHANGES_KEPT);
    on.plan_changes = `${changes.length} plan changes in the last 60 days, newest first. ` +
      `recent_plan_changes keeps the newest ${PLAN_CHANGES_KEPT}.`;
  }

  const tape = summary.body_measurements;
  if (tape && typeof tape === "object" && Object.keys(tape as Ctx).length > 0) {
    held.body_measurements = tape;
    delete summary.body_measurements;
    on.body_measurements = "Tape measurements: the latest and the oldest reading per site in the last 90 days.";
  }

  if (Object.keys(on).length > 0) summary.on_request = on;
  return { summary, held };
}

/** The coach_get_user_details tool: the held sections asked for. */
export function readHeldSections(held: HeldSections, input: Record<string, unknown>): unknown {
  const asked = Array.isArray(input.sections) ? input.sections.map(String) : [];
  const out: Ctx = {};
  const missing: string[] = [];
  for (const name of asked) {
    if ((ON_REQUEST_SECTIONS as readonly string[]).includes(name) && name in held) {
      out[name] = held[name as OnRequestSection];
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    out.not_available = `${missing.join(", ")}: not held for this user. Only sections listed in user_context.on_request exist.`;
  }
  return out;
}
