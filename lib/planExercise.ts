/**
 * How one exercise of a Drona-generated plan becomes database rows.
 *
 * Pure, so the deno suite can pin it: the save path in AICoachModal is the
 * only writer of a generated plan, and both of these used to be inline there,
 * where they quietly lost data. A NEW exercise was inserted as muscle group
 * "Other", equipment "Other", measured by weight and reps, whatever Drona
 * meant. A timed target like "45s" or "20min" parsed to NaN and fell back to
 * 8-12 reps, because routine_exercises has no column for a time or a distance.
 */
import {
  normalizeNewExercise,
  type NewExerciseDef,
} from '../supabase/functions/_shared/exerciseVocab';

export type { NewExerciseDef };

/**
 * Read the template off a plan exercise payload. Re-checked here rather than
 * trusted, because the payload crosses the network from whatever ai-coach
 * version is deployed. Anything that is not an object, or an object with none
 * of the three template fields, means "not new": an empty `{}` must not turn a
 * plain catalog name into an invention.
 */
export function parseNewExercise(raw: unknown): NewExerciseDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const muscle = str(r.muscle_group), equipment = str(r.category), measured = str(r.metric_type);
  if (muscle === undefined && equipment === undefined && measured === undefined) return undefined;
  return normalizeNewExercise(muscle, equipment, measured);
}

/**
 * The exercises row to insert when no row with this name exists yet. A plain
 * catalog name the lookup somehow missed keeps the old bare insert, and the
 * DB default (weight_reps) for its metric type.
 */
export function planExerciseInsert(ex: { name: string; new_exercise?: NewExerciseDef }): {
  name: string;
  muscle_group: string;
  category: string;
  metric_type?: NewExerciseDef['metric_type'];
} {
  const def = ex.new_exercise;
  if (!def) return { name: ex.name, muscle_group: 'Other', category: 'Other' };
  return { name: ex.name, muscle_group: def.muscle_group, category: def.category, metric_type: def.metric_type };
}

/**
 * A name as an ILIKE pattern that matches only itself. ILIKE reads % and _ as
 * wildcards and the backslash as their escape, so an invented "Band_Pull" would
 * otherwise also match "Band Pull" or "BandXPull" and reuse that exercise.
 */
export function ilikeExact(name: string): string {
  return name.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Leading rep count or range ("8-12", "12 to 15"), and whatever follows it ("/side", "s", "min"). */
const LEADING_REPS = /^\s*(\d+)\s*(?:(?:[-\u2013]|to\b)\s*(\d+))?\s*(.*)$/;
/** A range written high-to-low ("12-8") still stores min <= max. */
const ordered = (a: number, b: number) => ({ reps_min: Math.min(a, b), reps_max: Math.max(a, b) });

/** "3x10", "3 x 8-12", "3-4x10", "3 sets of 10": the leading part is sets, the rest is reps. */
const SETS_X_REPS = /^\s*\d+(?:\s*[-\u2013]\s*\d+)?\s*(?:[x\u00d7]|sets?\s+of)\s*(\d+)\s*(?:[-\u2013]\s*(\d+))?\s*$/i;
/** A suffix that makes the number a time, a distance or calories, not a rep count. */
const NON_REP_UNIT = /^(s|secs?|seconds?|min|mins|minutes?|m|meters?|metres?|km|mi|miles?|yd|yards?|cals?|kcals?)\b/i;

/**
 * Rep range and cue for a routine_exercises row. A rep target ("8-12", "5")
 * fills reps_min/reps_max as before, and so does the rep part of "10-12/side"
 * or "6-8 each", whose extra words then lead the cue. A time ("45s", "20min"),
 * a distance ("500m"), calories ("15cal") or a target with no number
 * ("AMRAP") has no column to live in, so it rides at the front of the cue
 * instead of being dropped, and the reps fall back to the table's own
 * defaults.
 */
export function planRepsAndNote(reps: string, note?: string | null): {
  reps_min: number;
  reps_max: number;
  note: string | null;
} {
  const target = (reps ?? '').trim();
  const cue = (note ?? '').trim();
  const withTarget = cue ? `Aim for ${target}. ${cue}` : `Aim for ${target}.`;
  // "3x10" / "3 x 8-12" is sets x reps: the reps are the part after the x.
  const sxr = SETS_X_REPS.exec(target);
  if (sxr) {
    const lo = Number(sxr[1]) || 8;
    return { ...ordered(lo, Number(sxr[2]) || lo), note: withTarget };
  }
  const m = LEADING_REPS.exec(target);
  // A decimal ("1.5min") is never a rep count, whatever follows it.
  if (m && !NON_REP_UNIT.test(m[3]) && !/^[.,]\d/.test(m[3])) {
    const lo = Number(m[1]) || 8;
    const rest = m[3].trim();
    const plain = rest === '' || /^reps?$/i.test(rest);
    return { ...ordered(lo, Number(m[2]) || lo), note: plain ? cue || null : withTarget };
  }
  if (!target) return { reps_min: 8, reps_max: 12, note: cue || null };
  return { reps_min: 8, reps_max: 12, note: withTarget };
}
