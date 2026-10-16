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
 * version is deployed. Anything that is not an object means "not new".
 */
export function parseNewExercise(raw: unknown): NewExerciseDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return normalizeNewExercise(str(r.muscle_group), str(r.category), str(r.metric_type));
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

const REP_TARGET = /^\s*(\d+)\s*(?:[-\u2013]\s*(\d+))?\s*(?:reps?)?\s*$/i;

/**
 * Rep range and cue for a routine_exercises row. A rep target ("8-12", "5")
 * fills reps_min/reps_max as before. Anything else ("45s", "20min") has no
 * column to live in, so it rides at the front of the cue instead of being
 * dropped, and the reps fall back to the table's own defaults.
 */
export function planRepsAndNote(reps: string, note?: string | null): {
  reps_min: number;
  reps_max: number;
  note: string | null;
} {
  const m = REP_TARGET.exec(reps ?? '');
  if (m) {
    const lo = Number(m[1]) || 8;
    return { reps_min: lo, reps_max: Number(m[2]) || lo || 12, note: note || null };
  }
  const target = (reps ?? '').trim();
  const cue = (note ?? '').trim();
  if (!target) return { reps_min: 8, reps_max: 12, note: cue || null };
  return { reps_min: 8, reps_max: 12, note: cue ? `Aim for ${target}. ${cue}` : `Aim for ${target}.` };
}
