/**
 * Shared exercise library used by both routine creation and active workout.
 * Matches the Figma reference exercise set.
 */

/**
 * How an exercise is measured (Phase A). Set once per exercise; the active set
 * row reads it to decide which input axes to render. `weight_reps` is the
 * default so normal lifters never see the concept. The DB mirrors this in
 * `exercises.metric_type` (migration 0043) with the same 8-value check.
 */
export type MetricType =
  | 'weight_reps'
  | 'bodyweight_reps'
  | 'weighted_bodyweight'
  | 'assisted_bodyweight'
  | 'duration'
  | 'duration_weight'
  | 'distance_duration'
  | 'weight_distance'
  | 'resistance_duration';

/** Default applied to any exercise/cached row that predates the metric_type column. */
export const DEFAULT_METRIC_TYPE: MetricType = 'weight_reps';

/** The input axes a set row can render. Stored as: weight axes -> weight_kg
 * (magnitude; the sign is implied by metric_type), reps -> reps,
 * duration -> duration_seconds, distance -> distance_m. */
export type MetricAxis = 'weight' | 'added_weight' | 'assist_weight' | 'reps' | 'duration' | 'distance' | 'resistance';

export interface MetricTypeDef {
  value: MetricType;
  /** Card title in the "Select Exercise Type" screen. */
  label: string;
  /** One-line column hint, e.g. "Kg · Reps". */
  sublabel: string;
  /** MaterialCommunityIcons glyph (provisional; revisit in the icon polish pass). */
  icon: string;
  /** Ordered input axes the set row renders for this type. */
  axes: MetricAxis[];
}

/** Authoritative descriptor list — drives both the type picker and the set row. */
export const METRIC_TYPES: MetricTypeDef[] = [
  { value: 'weight_reps', label: 'Weight & Reps', sublabel: 'Kg · Reps', icon: 'dumbbell', axes: ['weight', 'reps'] },
  { value: 'bodyweight_reps', label: 'Bodyweight Reps', sublabel: 'Reps', icon: 'arm-flex', axes: ['reps'] },
  { value: 'weighted_bodyweight', label: 'Weighted Bodyweight', sublabel: '+Kg · Reps', icon: 'weight-lifter', axes: ['added_weight', 'reps'] },
  { value: 'assisted_bodyweight', label: 'Assisted Bodyweight', sublabel: '−Kg · Reps', icon: 'weight', axes: ['assist_weight', 'reps'] },
  { value: 'duration', label: 'Duration', sublabel: 'Time', icon: 'timer-sand', axes: ['duration'] },
  { value: 'duration_weight', label: 'Duration & Weight', sublabel: 'Kg · Time', icon: 'timer', axes: ['weight', 'duration'] },
  { value: 'distance_duration', label: 'Distance & Duration', sublabel: 'Km · Time', icon: 'run', axes: ['distance', 'duration'] },
  { value: 'weight_distance', label: 'Weight & Distance', sublabel: 'Kg · Km', icon: 'walk', axes: ['weight', 'distance'] },
  { value: 'resistance_duration', label: 'Resistance & Duration', sublabel: 'Level · Time', icon: 'bike', axes: ['resistance', 'duration'] },
];

const METRIC_TYPE_BY_VALUE: Record<MetricType, MetricTypeDef> = Object.fromEntries(
  METRIC_TYPES.map((m) => [m.value, m]),
) as Record<MetricType, MetricTypeDef>;

/** Normalize any (possibly-missing or unknown) value to a valid MetricType. */
export function metricTypeOf(ex: { metric_type?: string | null } | null | undefined): MetricType {
  const v = ex?.metric_type;
  return v && v in METRIC_TYPE_BY_VALUE ? (v as MetricType) : DEFAULT_METRIC_TYPE;
}

/** Descriptor for a metric type, falling back to the default. */
export function metricTypeDef(value: string | null | undefined): MetricTypeDef {
  return METRIC_TYPE_BY_VALUE[metricTypeOf({ metric_type: value })];
}

/**
 * 1RM is only meaningful for rep-based loaded lifts. Wall-sits, carries, planks,
 * and pure cardio must never generate a phantom 1RM (plan: stats semantics).
 */
export function supports1RM(value: string | null | undefined): boolean {
  const t = metricTypeOf({ metric_type: value });
  return t === 'weight_reps' || t === 'weighted_bodyweight' || t === 'assisted_bodyweight';
}

export interface ExerciseDef {
  name: string;
  muscle_group: string;
  category: string;
  /** Optional + forward-safe: absent means weight_reps (see metricTypeOf). */
  metric_type?: MetricType;
  /** Demo image URLs (Phase E catalog). Present on DB-backed rows; absent on the
   * static seed + customs. Carried so pickers can show thumbnails later. */
  image_urls?: string[];
}

export const MUSCLE_GROUPS = [
  'Chest', 'Back', 'Shoulders', 'Quads', 'Hamstrings',
  'Glutes', 'Biceps', 'Triceps', 'Calves', 'Core',
] as const;

export const CATEGORIES = [
  'Barbell', 'Dumbbell', 'Cable', 'Machine', 'Bodyweight', 'Other',
] as const;

export const EXERCISE_LIBRARY: ExerciseDef[] = [
  // Chest
  { name: 'Bench Press', muscle_group: 'Chest', category: 'Barbell' },
  { name: 'Incline Dumbbell Press', muscle_group: 'Chest', category: 'Dumbbell' },
  { name: 'Cable Fly', muscle_group: 'Chest', category: 'Cable' },
  { name: 'Dumbbell Fly', muscle_group: 'Chest', category: 'Dumbbell' },
  { name: 'Incline Barbell Press', muscle_group: 'Chest', category: 'Barbell' },
  { name: 'Push-up', muscle_group: 'Chest', category: 'Bodyweight', metric_type: 'bodyweight_reps' },
  { name: 'Chest Dip', muscle_group: 'Chest', category: 'Bodyweight', metric_type: 'bodyweight_reps' },
  // Back
  { name: 'Deadlift', muscle_group: 'Back', category: 'Barbell' },
  { name: 'Barbell Row', muscle_group: 'Back', category: 'Barbell' },
  { name: 'Pull-up', muscle_group: 'Back', category: 'Bodyweight', metric_type: 'bodyweight_reps' },
  { name: 'Lat Pulldown', muscle_group: 'Back', category: 'Cable' },
  { name: 'Seated Cable Row', muscle_group: 'Back', category: 'Cable' },
  { name: 'T-Bar Row', muscle_group: 'Back', category: 'Barbell' },
  { name: 'Dumbbell Row', muscle_group: 'Back', category: 'Dumbbell' },
  // Shoulders
  { name: 'Overhead Press', muscle_group: 'Shoulders', category: 'Barbell' },
  { name: 'Lateral Raise', muscle_group: 'Shoulders', category: 'Dumbbell' },
  { name: 'Face Pull', muscle_group: 'Shoulders', category: 'Cable' },
  { name: 'Arnold Press', muscle_group: 'Shoulders', category: 'Dumbbell' },
  { name: 'Rear Delt Fly', muscle_group: 'Shoulders', category: 'Dumbbell' },
  { name: 'Front Raise', muscle_group: 'Shoulders', category: 'Dumbbell' },
  // Quads
  { name: 'Squat', muscle_group: 'Quads', category: 'Barbell' },
  { name: 'Leg Press', muscle_group: 'Quads', category: 'Machine' },
  { name: 'Leg Extension', muscle_group: 'Quads', category: 'Machine' },
  { name: 'Bulgarian Split Squat', muscle_group: 'Quads', category: 'Dumbbell' },
  { name: 'Hack Squat', muscle_group: 'Quads', category: 'Machine' },
  // Hamstrings
  { name: 'Romanian Deadlift', muscle_group: 'Hamstrings', category: 'Barbell' },
  { name: 'Leg Curl', muscle_group: 'Hamstrings', category: 'Machine' },
  { name: 'Good Morning', muscle_group: 'Hamstrings', category: 'Barbell' },
  // Glutes
  { name: 'Hip Thrust', muscle_group: 'Glutes', category: 'Barbell' },
  { name: 'Glute Bridge', muscle_group: 'Glutes', category: 'Bodyweight', metric_type: 'bodyweight_reps' },
  { name: 'Cable Kickback', muscle_group: 'Glutes', category: 'Cable' },
  // Biceps
  { name: 'Barbell Curl', muscle_group: 'Biceps', category: 'Barbell' },
  { name: 'Dumbbell Curl', muscle_group: 'Biceps', category: 'Dumbbell' },
  { name: 'Hammer Curl', muscle_group: 'Biceps', category: 'Dumbbell' },
  { name: 'Preacher Curl', muscle_group: 'Biceps', category: 'Machine' },
  // Triceps
  { name: 'Tricep Pushdown', muscle_group: 'Triceps', category: 'Cable' },
  { name: 'Skull Crusher', muscle_group: 'Triceps', category: 'Barbell' },
  { name: 'Overhead Tricep Extension', muscle_group: 'Triceps', category: 'Dumbbell' },
  { name: 'Close-grip Bench Press', muscle_group: 'Triceps', category: 'Barbell' },
  // Calves
  { name: 'Calf Raise', muscle_group: 'Calves', category: 'Machine' },
  { name: 'Seated Calf Raise', muscle_group: 'Calves', category: 'Machine' },
  // Core
  { name: 'Plank', muscle_group: 'Core', category: 'Bodyweight', metric_type: 'duration' },
  { name: 'Ab Crunch', muscle_group: 'Core', category: 'Bodyweight', metric_type: 'bodyweight_reps' },
  { name: 'Russian Twist', muscle_group: 'Core', category: 'Bodyweight', metric_type: 'bodyweight_reps' },
  { name: 'Cable Crunch', muscle_group: 'Core', category: 'Cable' },
  { name: 'Hanging Leg Raise', muscle_group: 'Core', category: 'Bodyweight', metric_type: 'bodyweight_reps' },
];

/** Search exercises by name or muscle group */
export function searchExercises(query: string, library = EXERCISE_LIBRARY): ExerciseDef[] {
  const q = query.toLowerCase().trim();
  if (!q) return library;
  return library.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.muscle_group.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q),
  );
}

/** Get exercises grouped by muscle group */
export function exercisesByMuscle(library = EXERCISE_LIBRARY) {
  const grouped: Record<string, ExerciseDef[]> = {};
  for (const ex of library) {
    if (!grouped[ex.muscle_group]) grouped[ex.muscle_group] = [];
    grouped[ex.muscle_group].push(ex);
  }
  return grouped;
}
