/**
 * The custom-exercise template: every value an exercise row's muscle_group,
 * category and metric_type can take, as Drona's plan generation needs it when
 * it invents an exercise the catalog lacks and has to describe it in exactly
 * the words the app's create / edit form stores.
 *
 * This is a MIRROR of lib/exercises.ts, not the source. lib/exercises.ts cannot
 * import it: the app resolves extensionless imports and Deno does not, and
 * _shared/todayPick.test.ts loads lib/exercises.ts under Deno. So the lists are
 * copied, and exerciseVocab.test.ts fails the moment the two copies differ. A
 * drifted value would either fail the DB's metric_type check or land in a
 * muscle group no screen shows.
 *
 * Pure TS with no Deno or RN imports, so both runtimes can load it.
 */

/**
 * How an exercise is measured (Phase A). Set once per exercise; the active set
 * row reads it to decide which input axes to render. `weight_reps` is the
 * default so normal lifters never see the concept. The DB mirrors this in
 * `exercises.metric_type` (migration 0043).
 */
export const METRIC_TYPE_VALUES = [
  'weight_reps',
  'bodyweight_reps',
  'weighted_bodyweight',
  'assisted_bodyweight',
  'duration',
  'duration_weight',
  'distance_duration',
  'weight_distance',
  'resistance_duration',
] as const;

export type MetricType = typeof METRIC_TYPE_VALUES[number];

/** Default applied to any exercise/cached row that predates the metric_type column. */
export const DEFAULT_METRIC_TYPE: MetricType = 'weight_reps';

/**
 * The primary picks in the create/edit custom exercise form: the ten classic
 * groups, Forearms (its own region — it has its own sub-muscles), and the two
 * non-lifting buckets. This is the whole list a casual user ever sees — one
 * tap on "Back" and they are done. Ordered so the arm picks sit together.
 */
export const CUSTOM_MUSCLE_GROUPS = [
  'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Forearms',
  'Core', 'Quads', 'Hamstrings', 'Glutes', 'Calves',
  'Cardio', 'Other',
] as const;

/**
 * Optional finer heads, revealed only AFTER the matching primary is picked
 * (progressive disclosure — the form never shows the full vocabulary at
 * once). Selecting "Back" offers Lats/Upper Back/Lower Back/Traps
 * underneath; ignoring the row keeps plain "Back".
 *
 * Naming: gym-speak over anatomy-textbook, and heads that would be ambiguous
 * on their own carry their parent's name ("Triceps Long Head", not "Long
 * Head") because the stored value shows by itself in Analytics legends and
 * workout headers. The picker strips the parent prefix on the chip label, so
 * the refine row still reads Long Head / Lateral Head / Medial Head.
 *
 * A head may hang off several primaries (Adductors under any leg pick) so it
 * is reachable from wherever the user starts. Every value here is mapped in
 * `GROUP_SLUGS` (components/ui/BodyHeatmap) so it lights the right region on
 * the body picture in Analytics and on the post-workout share card.
 *
 * `muscle_group` is free text in Postgres (no check constraint), so adding a
 * head needs no migration.
 */
export const MUSCLE_GROUP_REFINEMENTS: Record<string, readonly string[]> = {
  Chest: ['Upper Chest', 'Mid Chest', 'Lower Chest'],
  Back: ['Lats', 'Upper Back', 'Lower Back', 'Traps'],
  Shoulders: ['Front Delts', 'Side Delts', 'Rear Delts', 'Neck'],
  Biceps: ['Biceps Long Head', 'Biceps Short Head', 'Brachialis'],
  Triceps: ['Triceps Long Head', 'Triceps Lateral Head', 'Triceps Medial Head'],
  Forearms: ['Wrist Flexors', 'Wrist Extensors', 'Brachioradialis', 'Grip'],
  Core: ['Abs', 'Lower Abs', 'Obliques'],
  Quads: ['Outer Quads', 'Inner Quads', 'Hip Flexors', 'Adductors'],
  Hamstrings: ['Adductors'],
  Glutes: ['Glute Max', 'Glute Medius', 'Adductors'],
  Calves: ['Gastrocnemius', 'Soleus', 'Tibialis'],
};

/** Every value the picker can produce — primaries plus all refinement heads. */
export const ALL_MUSCLE_GROUPS: string[] = [
  ...new Set([...CUSTOM_MUSCLE_GROUPS, ...Object.values(MUSCLE_GROUP_REFINEMENTS).flat()]),
];

/** Equipment, stored in `exercises.category`. */
export const CATEGORIES = [
  'Barbell', 'Dumbbell', 'Cable', 'Machine', 'Bodyweight', 'Other',
] as const;

/** The template a newly invented exercise carries alongside its name. */
export interface NewExerciseDef {
  muscle_group: string;
  category: string;
  metric_type: MetricType;
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function pick(raw: string, allowed: readonly string[]): string | null {
  const key = loose(raw);
  if (!key) return null;
  return allowed.find((v) => loose(v) === key) ?? null;
}

/**
 * Turn the model's three free-text fields into a template the DB and every
 * screen accept. Matching is loose on case and punctuation ("weight reps",
 * "Weight-Reps"), and any value outside the vocabulary falls back to the same
 * default the create form starts on, so a bad field can never fail the insert.
 */
export function normalizeNewExercise(
  muscle: string | undefined,
  equipment: string | undefined,
  measuredBy: string | undefined,
): NewExerciseDef {
  return {
    muscle_group: pick(muscle ?? '', ALL_MUSCLE_GROUPS) ?? 'Other',
    category: pick(equipment ?? '', CATEGORIES) ?? 'Other',
    metric_type: (pick(measuredBy ?? '', METRIC_TYPE_VALUES) as MetricType | null) ?? DEFAULT_METRIC_TYPE,
  };
}
