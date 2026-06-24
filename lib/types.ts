export type CoachGoal = 'hypertrophy' | 'strength' | 'fat_loss' | 'endurance' | 'general';
export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced';

export interface UserProfile {
  id: string;
  clerk_user_id: string;
  name: string;
  email: string;
  avatar_url?: string;
  gender?: 'M' | 'F' | 'O';
  height_cm?: number;
  weight_kg?: number;
  goal_weight_kg?: number;
  body_fat_percent?: number;
  level: number;
  xp: number;
  streak: number;
  created_at: string;
  // Phase 0 — coach context fields. Nullable; UI nudges users to fill them.
  goal?: CoachGoal;
  experience_level?: ExperienceLevel;
  training_age_months?: number;
  date_of_birth?: string;
  weekly_target_sessions?: number;
}

export interface Exercise {
  id: string;
  name: string;
  muscle_group: string;
  category: string;
  /** Phase A measurement type. Optional + forward-safe: absent means
   * weight_reps (use metricTypeOf from lib/exercises). */
  metric_type?: import('@/lib/exercises').MetricType;
  /** Catalog enrichment (Phase E ingest). */
  instructions?: string[];
  image_urls?: string[];
}

export interface RoutineExercise {
  exercise_id: string;
  exercise: Exercise;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number;
  order: number;
  // Phase 2.5: coach cue persisted from generate_workout / generate_plan
  // (e.g. "RIR 2", "Hams-focused", "Top set to failure"). Optional — only
  // set on AI-generated routines, not editor-built ones.
  note?: string;
}

export interface Routine {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  color: string;
  exercises: RoutineExercise[];
  created_at: string;
}

export interface WorkoutSet {
  id: string;
  exercise_id: string;
  exercise?: Exercise;
  weight_kg: number;
  reps: number;
  completed: boolean;
  order: number;
  // Phase A — non-weight/rep axes. Nullable; only the axes the exercise's
  // metric_type uses are populated. weight_kg stores the magnitude for the
  // ±Kg (weighted/assisted) types; the sign is implied by metric_type.
  duration_seconds?: number | null;
  distance_m?: number | null;
  // resistance level for cardio machines (bike/elliptical), resistance_duration.
  resistance?: number | null;
}

export interface Workout {
  id: string;
  user_id: string;
  routine_id?: string;
  routine?: Routine;
  name: string;
  started_at: string;
  finished_at?: string;
  duration_seconds?: number;
  total_volume_kg?: number;
  notes?: string;
  sets: WorkoutSet[];
}

export interface ActiveWorkoutExercise {
  exercise: Exercise;
  sets: ActiveSet[];
  // User-editable session notes (typed during the workout).
  notes: string;
  // Phase 2.5: read-only coach cue carried over from the routine
  // (the `routine_exercises.note` column). Displayed as a subtle hint
  // above the exercise; not mutated by the user.
  coachNote?: string;
  previousSets?: { weight_kg: number; reps: number }[];
  targetSets: number;
  repsMin: number;
  repsMax: number;
  restSeconds: number;
}

export interface ActiveSet {
  weight_kg: number;
  reps: number;
  completed: boolean;
  // Phase A — populated per the exercise's metric_type (see ActiveSet axes in
  // WorkoutSet). All nullable; weight_kg/reps stay the kg/rep axes.
  duration_seconds?: number | null;
  distance_m?: number | null;
  resistance?: number | null;
}

export interface DashboardStats {
  workoutsThisWeek: number;
  streakDays: number;
  totalVolumeKg: number;
  topMuscle: string;
  topMusclePercent: number;
  avgDurationMin: number;
  totalSets: number;
  totalReps: number;
}

export type MuscleGroup =
  | 'Chest' | 'Back' | 'Shoulders' | 'Biceps' | 'Triceps'
  | 'Quads' | 'Hamstrings' | 'Glutes' | 'Calves' | 'Core' | 'Full Body';
