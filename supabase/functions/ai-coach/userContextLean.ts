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
/** Volume tables this long or shorter are sent whole: a fetch would cost more. */
const VOLUME_WHOLE_MAX = 8;
/** Tape summaries with this many sites or fewer are sent whole. */
const TAPE_SITES_WHOLE_MAX = 4;

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

  // Routines arrive newest first: get_user_coach_context aggregates them
  // `order by r.created_at desc` (0096_coach_programs.sql).
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
        : "active_routines lists them by name only.") +
      " routine_names reads any saved routine by name, listed here or not.";
  }

  const volume = summary.weekly_volume;
  if (Array.isArray(volume) && volume.length > VOLUME_WHOLE_MAX) {
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

  // summarizeMeasurements (memory.ts): { latest_on, days_logged, sites: [...] }.
  const tape = summary.body_measurements;
  const tapeSites = (tape as { sites?: unknown } | null)?.sites;
  if (Array.isArray(tapeSites) && tapeSites.length > TAPE_SITES_WHOLE_MAX) {
    held.body_measurements = tape;
    delete summary.body_measurements;
    on.body_measurements = "Tape measurements: the latest and the oldest reading per site in the last 90 days.";
  }

  if (Object.keys(on).length > 0) summary.on_request = on;
  return { summary, held };
}

/**
 * The coach_get_user_details tool: the held sections asked for. routine_names
 * narrows routines to the named ones (any case): a tool result is not cached
 * and rides every later loop turn, so one routine should not bring back 52.
 */
export function readHeldSections(held: HeldSections, input: Record<string, unknown>): unknown {
  const asked = Array.isArray(input.sections) ? input.sections.map(String) : [];
  const wanted = Array.isArray(input.routine_names) ? input.routine_names.map((n) => String(n).trim()).filter(Boolean) : [];
  const out: Ctx = {};
  const missing: string[] = [];
  const unknownRoutines: string[] = [];
  for (const name of asked) {
    if (!(ON_REQUEST_SECTIONS as readonly string[]).includes(name) || !(name in held)) {
      missing.push(name);
      continue;
    }
    const section = held[name as OnRequestSection];
    if (name === "routines" && wanted.length > 0 && Array.isArray(section)) {
      const nameOf = (r: unknown) => String((r as { name?: unknown })?.name ?? "").toLowerCase();
      // The exact name when one matches, else every routine whose name holds
      // it ("push" finds "Push Day A"), so a short name does not cost a retry.
      const picked = new Set<unknown>();
      for (const asked of wanted) {
        const w = asked.toLowerCase();
        const exact = section.filter((r) => nameOf(r) === w);
        const hits = exact.length > 0 ? exact : section.filter((r) => nameOf(r).includes(w));
        if (hits.length === 0) unknownRoutines.push(asked);
        for (const h of hits) picked.add(h);
      }
      out.routines = section.filter((r) => picked.has(r));
    } else {
      out[name] = section;
    }
  }
  // A name not found is not a missing section: routines exist, that name does not.
  if (unknownRoutines.length > 0) {
    out.unknown_routines = `No saved routine is named ${unknownRoutines.map((w) => `'${w}'`).join(", ")}. ` +
      "Ask for routines without routine_names to see every routine.";
  }
  if (missing.length > 0) {
    out.not_available = `${missing.join(", ")}: not held for this user. Only sections listed in user_context.on_request exist.`;
  }
  return out;
}
