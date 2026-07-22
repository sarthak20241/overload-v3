/**
 * Compact line encoding for generated plans, and the deterministic parser
 * that turns it back into the generate_plan JSON the client already expects.
 *
 * WHY THIS EXISTS
 * Measured: latency = 62ms + 16.35ms x output_tokens (R^2=0.971), and the
 * production tool_use payload spends ~82 output tokens per exercise, most of
 * it JSON ceremony:
 *
 *   {"name": "Incline Dumbbell Press", "sets": 3, "reps": "8-12",
 *    "rest_seconds": 90, "note": "Full stretch at the bottom"}
 *
 * The same content as a line is ~22 tokens:
 *
 *   EX | Incline Dumbbell Press | 3 | 8-12 | 90 | full stretch at the bottom
 *
 * Cues are preserved in full. Nothing about the client contract changes,
 * because the parser below reconstructs the identical JSON shape.
 *
 * Secondary benefit, also measured: forced tool_choice does not stream (50%
 * of payload arrives at 98% of wall clock). Plain text does (50% by 63%), so
 * this format makes progressive rendering possible again.
 *
 * PARSING PHILOSOPHY
 * Be liberal. A dropped exercise is far worse than a slightly-off cue, so
 * every field has a fallback and unparseable lines are skipped rather than
 * throwing. The eval's deterministic scorer is what catches real damage.
 */

export interface ParsedExercise {
  name: string;
  sets: number;
  reps: string;
  rest_seconds: number;
  note?: string;
}

export interface ParsedWorkout {
  name: string;
  note?: string;
  exercises: ParsedExercise[];
}

export interface ParsedPlan {
  name: string;
  split_type?: string;
  days_per_week?: number;
  rationale: string;
  workouts: ParsedWorkout[];
}

/** Skeleton-only shape: days and their assigned movements, no prescriptions. */
export interface PlanSkeleton {
  name: string;
  split_type?: string;
  days_per_week?: number;
  days: { name: string; note?: string; slots: string[] }[];
}

const cell = (s: string | undefined) => (s ?? '').trim();

function toInt(s: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = parseInt(cell(s), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * The format we ask the model to emit. Kept here next to the parser so the
 * two can never drift, and injected verbatim into the prompts.
 */
export const COMPACT_FORMAT_SPEC = `Emit the plan in this EXACT line format. No JSON, no markdown, no code fences, no commentary before or after.

PLAN | <plan name> | <split type> | <days per week>
WHY | <3-4 sentences on ONE line, no line breaks, no lists>
DAY | <workout name> | <one-line focus for this session>
EX | <exercise name> | <sets> | <reps> | <rest seconds> | <short coaching cue>
EX | ...
DAY | <next workout name> | <focus>
EX | ...

Rules for the fields:
- One EX line per exercise. Repeat DAY for each distinct workout.
- <sets> is a plain integer 1-6. <rest seconds> is a plain integer 30-300.
- <reps> is a plain range like 6-10, or a single number like 5. For a timed
  exercise (planks, carries, holds) write the seconds as a number followed by
  s, e.g. 45s. Never write units in the sets or rest fields.
- <coaching cue> is a short phrase on intent or execution. Omit the trailing
  " | <cue>" entirely if the exercise needs no cue.
- Never use the | character inside any field value.`;

/** Parse the full compact plan format. */
export function parseCompactPlan(raw: string): ParsedPlan | null {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  let name = '';
  let split_type: string | undefined;
  let days_per_week: number | undefined;
  let rationale = '';
  const workouts: ParsedWorkout[] = [];

  for (const line of lines) {
    // Tolerate a stray code fence or leading bullet the model sometimes adds.
    const clean = line.replace(/^[`*\-\s]+/, '');
    const parts = clean.split('|');
    const tag = cell(parts[0]).toUpperCase();

    if (tag === 'PLAN') {
      name = cell(parts[1]) || name;
      split_type = cell(parts[2]) || undefined;
      const d = parseInt(cell(parts[3]), 10);
      if (Number.isFinite(d)) days_per_week = d;
    } else if (tag === 'WHY') {
      // Rejoin: a rationale containing "|" would otherwise be truncated.
      rationale = parts.slice(1).join('|').trim();
    } else if (tag === 'DAY') {
      workouts.push({
        name: cell(parts[1]) || `Day ${workouts.length + 1}`,
        note: cell(parts[2]) || undefined,
        exercises: [],
      });
    } else if (tag === 'EX') {
      if (workouts.length === 0) continue; // EX before any DAY: nothing to attach to
      const exName = cell(parts[1]);
      if (!exName) continue;
      workouts[workouts.length - 1].exercises.push({
        name: exName,
        sets: toInt(parts[2], 3, 1, 6),
        reps: cell(parts[3]) || '8-12',
        rest_seconds: toInt(parts[4], 90, 30, 300),
        note: cell(parts[5]) || undefined,
      });
    }
  }

  if (workouts.length === 0) return null;
  return { name: name || 'Training Plan', split_type, days_per_week, rationale, workouts };
}

/** Format spec for the skeleton call in the fan-out variant. */
export const SKELETON_FORMAT_SPEC = `Emit ONLY this exact line format. No JSON, no markdown, no code fences, no commentary.

PLAN | <plan name> | <split type> | <days per week>
DAY | <workout name> | <one-line focus for this session>
SLOT | <exact exercise name from the catalog>
SLOT | <exact exercise name from the catalog>
DAY | <next workout name> | <focus>
SLOT | ...

Rules:
- One SLOT line per exercise, in the order they should be performed, compounds first.
- SLOT carries ONLY the exercise name. No sets, no reps, no rest, no cue.
- Every SLOT name must be copied character-for-character from the catalog.
- Never use the | character inside a field value.`;

export function parseSkeleton(raw: string): PlanSkeleton | null {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let name = '';
  let split_type: string | undefined;
  let days_per_week: number | undefined;
  const days: PlanSkeleton['days'] = [];

  for (const line of lines) {
    const parts = line.replace(/^[`*\-\s]+/, '').split('|');
    const tag = cell(parts[0]).toUpperCase();
    if (tag === 'PLAN') {
      name = cell(parts[1]) || name;
      split_type = cell(parts[2]) || undefined;
      const d = parseInt(cell(parts[3]), 10);
      if (Number.isFinite(d)) days_per_week = d;
    } else if (tag === 'DAY') {
      days.push({ name: cell(parts[1]) || `Day ${days.length + 1}`, note: cell(parts[2]) || undefined, slots: [] });
    } else if (tag === 'SLOT') {
      if (days.length === 0) continue;
      const n = cell(parts[1]);
      if (n) days[days.length - 1].slots.push(n);
    }
  }

  if (days.length === 0 || days.every((d) => d.slots.length === 0)) return null;
  return { name: name || 'Training Plan', split_type, days_per_week, days };
}

/** Format spec for a single day-fill in the fan-out variant. */
export const FILL_FORMAT_SPEC = `Emit ONLY EX lines, one per exercise, in the order given. No JSON, no markdown, no commentary, no DAY line.

EX | <exercise name exactly as given> | <sets> | <reps> | <rest seconds> | <short coaching cue>

Rules:
- One EX line per assigned exercise, same order, same names. Do not add, drop, rename, or reorder exercises.
- <sets> is a plain integer 1-6. <rest seconds> is a plain integer 30-300.
- <reps> is a plain range like 6-10, or a single number like 5. For a timed
  exercise (planks, carries, holds) write seconds as a number followed by s,
  e.g. 45s.
- <coaching cue> is a short phrase on intent or execution. Omit the trailing
  " | <cue>" entirely if the exercise needs no cue.
- Never use the | character inside a field value.`;

/** Parse the EX lines returned by one day-fill call. */
export function parseFill(raw: string): ParsedExercise[] {
  const out: ParsedExercise[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.trim().replace(/^[`*\-\s]+/, '').split('|');
    if (cell(parts[0]).toUpperCase() !== 'EX') continue;
    const name = cell(parts[1]);
    if (!name) continue;
    out.push({
      name,
      sets: toInt(parts[2], 3, 1, 6),
      reps: cell(parts[3]) || '8-12',
      rest_seconds: toInt(parts[4], 90, 30, 300),
      note: cell(parts[5]) || undefined,
    });
  }
  return out;
}

/**
 * Stitch skeleton + per-day fills + rationale into the final plan.
 *
 * The skeleton is the source of truth for structure and for which movement
 * sits in each slot: a fill that renamed or dropped an exercise gets
 * corrected back here rather than silently changing the plan. That keeps
 * cross-day variant assignment a property of the one call that saw the whole
 * week, which is the entire point of the split.
 */
export function assemblePlan(
  skeleton: PlanSkeleton,
  fills: (ParsedExercise[] | null)[],
  rationale: string,
): ParsedPlan {
  const workouts: ParsedWorkout[] = skeleton.days.map((day, i) => {
    const filled = fills[i] ?? [];
    const byName = new Map(filled.map((e) => [e.name.toLowerCase().replace(/\s+/g, ' ').trim(), e]));
    const exercises: ParsedExercise[] = day.slots.map((slot, j) => {
      const hit = byName.get(slot.toLowerCase().replace(/\s+/g, ' ').trim())
        // Positional fallback: the fill kept order but drifted on the name.
        ?? filled[j];
      return {
        name: slot, // skeleton wins on naming, always
        sets: hit?.sets ?? 3,
        reps: hit?.reps ?? '8-12',
        rest_seconds: hit?.rest_seconds ?? 90,
        note: hit?.note,
      };
    });
    return { name: day.name, note: day.note, exercises };
  });

  return {
    name: skeleton.name,
    split_type: skeleton.split_type,
    days_per_week: skeleton.days_per_week,
    rationale: rationale.trim(),
    workouts,
  };
}
