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
