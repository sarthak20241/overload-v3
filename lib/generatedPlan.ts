/**
 * The plan and workout shapes Drona's generate_plan / generate_workout tools
 * hand back, and the parsers that turn the tool input into them. Shared by the
 * coach sheet (components/ai/AICoachModal.tsx) and the phase draft store
 * (lib/phaseDraft.ts), which keeps a built phase plan until it is saved.
 */
import { parseNewExercise, type NewExerciseDef } from '@/lib/planExercise';

export interface GeneratedExercise {
  name: string;
  sets: number;
  reps: string;
  rest: string;
  // Phase 2.5: coaching cue. Examples: "RIR 2", "Go heavy, control eccentric",
  // "Hams-focused, push hips back", "Last set to failure".
  note?: string;
  // Set when Drona invented this exercise because the catalog had nothing
  // that fit (a stretch, a mobility drill). Saved as the user's own custom.
  new_exercise?: NewExerciseDef;
}

export interface GeneratedWorkout {
  name: string;
  exercises: GeneratedExercise[];
  // Phase 2.5: explanation shown above the exercise list — why this workout
  // fits THIS user. Set by the coach's generate_workout tool. Optional so
  // older callers (mocks) still type-check.
  rationale?: string;
  focus?: string;
  estimated_duration_min?: number;
}

export interface GeneratedPlan {
  name: string;
  rationale: string;
  split_type?: string;
  days_per_week?: number;
  workouts: Array<GeneratedWorkout & { note?: string }>;
}

// Normalize the structured input from generate_workout/generate_plan into
// our GeneratedWorkout shape (the existing one used rest as "90s" strings;
// the tool schema uses rest_seconds as int — we convert).
export function structuredToWorkout(input: Record<string, unknown>): GeneratedWorkout {
  const exercises = Array.isArray(input.exercises)
    ? (input.exercises as Array<Record<string, unknown>>).map((e) => ({
        name: String(e.name ?? ''),
        sets: Number(e.sets ?? 3),
        reps: String(e.reps ?? '8-12'),
        rest: typeof e.rest_seconds === 'number' ? `${e.rest_seconds}s` : '90s',
        note: typeof e.note === 'string' && e.note.length > 0 ? e.note : undefined,
        new_exercise: parseNewExercise(e.new_exercise),
      }))
    : [];
  return {
    name: String(input.name ?? 'New Workout'),
    rationale: typeof input.rationale === 'string' ? input.rationale : undefined,
    focus: typeof input.focus === 'string' ? input.focus : undefined,
    estimated_duration_min: typeof input.estimated_duration_min === 'number'
      ? input.estimated_duration_min
      : undefined,
    exercises,
  };
}

export function structuredToPlan(input: Record<string, unknown>): GeneratedPlan {
  const workouts = Array.isArray(input.workouts)
    ? (input.workouts as Array<Record<string, unknown>>).map((w) => ({
        ...structuredToWorkout(w),
        note: typeof w.note === 'string' && w.note.length > 0 ? w.note : undefined,
      }))
    : [];
  return {
    name: String(input.name ?? 'New Plan'),
    rationale: String(input.rationale ?? ''),
    split_type: typeof input.split_type === 'string' ? input.split_type : undefined,
    days_per_week: typeof input.days_per_week === 'number' ? input.days_per_week : undefined,
    workouts,
  };
}
