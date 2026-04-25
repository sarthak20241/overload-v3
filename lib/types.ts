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
  notes: string;
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
