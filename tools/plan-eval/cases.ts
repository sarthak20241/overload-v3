/**
 * Fixture set for the generate_plan eval harness.
 *
 * Two variants, because two surfaces call generate_plan with very different
 * inputs and very different stakes:
 *
 *   onboarding — a fresh account with NO training history, called from the
 *                build moment during signup (PR #66). Highest volume, hardest
 *                case (nothing to condition on), and the one where latency
 *                costs you the user. The intake message is catalog-grounded:
 *                every emitted exercise name must come from EXERCISE_LIBRARY.
 *
 *   coach      — the AI Coach modal's Generate Plan form, for a user with
 *                real history. Free-text exercise names, resolved on save.
 *
 * Cases carry the intake AND the expectations, so scoring is a pure function
 * of (case, result). Add a case by appending here; nothing else to touch.
 */
import type { CoachGoal, ExperienceLevel } from '../../lib/types';

export interface OnboardingIntake {
  goal: CoachGoal;
  experience: ExperienceLevel;
  frequency: number;
  gender?: 'male' | 'female';
  ageYears?: number;
  heightCm?: number;
  weightKg?: number;
  goalWeightKg?: number;
  weeklyRateKg?: number | null;
  direction?: 'loss' | 'gain' | null;
  targets?: { kcal: number; protein: number; carb: number; fat: number } | null;
}

export interface CoachIntake {
  goal: string;
  days: number;
  sessionLength: string;
  level: string;
  /** Synthetic get_user_coach_context() blob. Keeps the harness hermetic:
   *  no Supabase round trip, and the same context every run so latency
   *  deltas are attributable to the pipeline, not to shifting input size. */
  userContext: Record<string, unknown> | null;
}

export interface Expectations {
  /** Sessions per week the user asked for. */
  daysPerWeek: number;
  /** Distinct workouts. Fewer than daysPerWeek is legal (they rotate). */
  minWorkouts: number;
  maxWorkouts: number;
  minExercisesPerWorkout: number;
  maxExercisesPerWorkout: number;
  /** Fraction of emitted exercise names that must resolve to the catalog.
   *  Onboarding drops unresolved names and falls back entirely above 30%
   *  unresolved, so anything under 1.0 is already degraded output. */
  minCatalogResolution: number;
}

export type EvalCase =
  | { id: string; variant: 'onboarding'; intake: OnboardingIntake; expect: Expectations }
  | { id: string; variant: 'coach'; intake: CoachIntake; expect: Expectations };

const HISTORY_CONTEXT: Record<string, unknown> = {
  profile: { goal: 'hypertrophy', experience_level: 'intermediate', bodyweight_kg: 78 },
  training_inactive: false,
  last_workout: { name: 'Push Day', date: '2026-07-17', total_sets: 18 },
  top_lifts: [
    { exercise: 'Bench Press', best_weight_kg: 92.5, best_reps: 5 },
    { exercise: 'Barbell Squat', best_weight_kg: 140, best_reps: 3 },
    { exercise: 'Deadlift', best_weight_kg: 175, best_reps: 3 },
  ],
  weekly_sets_by_muscle: { Chest: 14, Back: 16, Legs: 18, Shoulders: 10, Arms: 12 },
  sessions_last_28_days: 15,
};

/** Fresh-account onboarding grid: every goal, and the frequencies that change
 *  the split decision (3 = full body, 4 = upper/lower, 5-6 = PPL). */
const ONBOARDING_CASES: EvalCase[] = [
  {
    id: 'onb-hypertrophy-3d-beginner',
    variant: 'onboarding',
    intake: {
      goal: 'hypertrophy', experience: 'beginner', frequency: 3,
      gender: 'male', ageYears: 24, heightCm: 178, weightKg: 72,
      goalWeightKg: 78, weeklyRateKg: 0.25, direction: 'gain',
      targets: { kcal: 2750, protein: 158, carb: 316, fat: 76 },
    },
    expect: { daysPerWeek: 3, minWorkouts: 1, maxWorkouts: 3, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  {
    id: 'onb-fatloss-4d-beginner',
    variant: 'onboarding',
    intake: {
      goal: 'fat_loss', experience: 'beginner', frequency: 4,
      gender: 'female', ageYears: 31, heightCm: 164, weightKg: 71,
      goalWeightKg: 63, weeklyRateKg: 0.5, direction: 'loss',
      targets: { kcal: 1680, protein: 128, carb: 155, fat: 52 },
    },
    expect: { daysPerWeek: 4, minWorkouts: 2, maxWorkouts: 4, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  {
    id: 'onb-strength-4d-intermediate',
    variant: 'onboarding',
    intake: {
      goal: 'strength', experience: 'intermediate', frequency: 4,
      gender: 'male', ageYears: 28, heightCm: 182, weightKg: 88,
      targets: { kcal: 3100, protein: 176, carb: 340, fat: 92 },
    },
    expect: { daysPerWeek: 4, minWorkouts: 2, maxWorkouts: 4, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  {
    id: 'onb-hypertrophy-6d-advanced',
    variant: 'onboarding',
    intake: {
      goal: 'hypertrophy', experience: 'advanced', frequency: 6,
      gender: 'male', ageYears: 33, heightCm: 175, weightKg: 82,
      targets: { kcal: 2950, protein: 180, carb: 320, fat: 82 },
    },
    // The worst latency case in the set: 6 distinct workouts is the most
    // output tokens generate_plan is ever asked for.
    expect: { daysPerWeek: 6, minWorkouts: 3, maxWorkouts: 6, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  {
    id: 'onb-endurance-2d-beginner',
    variant: 'onboarding',
    intake: {
      goal: 'endurance', experience: 'beginner', frequency: 2,
      gender: 'female', ageYears: 45, heightCm: 158, weightKg: 60,
      targets: { kcal: 1850, protein: 108, carb: 208, fat: 58 },
    },
    // Floor case: the fastest generate_plan should ever be. Anchors the
    // "how much of the latency is fixed overhead" question.
    expect: { daysPerWeek: 2, minWorkouts: 1, maxWorkouts: 2, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  {
    id: 'onb-general-5d-intermediate',
    variant: 'onboarding',
    intake: {
      goal: 'general', experience: 'intermediate', frequency: 5,
      gender: 'male', ageYears: 38, heightCm: 180, weightKg: 91,
      goalWeightKg: 84, weeklyRateKg: 0.4, direction: 'loss',
      targets: { kcal: 2400, protein: 164, carb: 232, fat: 74 },
    },
    expect: { daysPerWeek: 5, minWorkouts: 3, maxWorkouts: 5, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  // ── Boundary cases ────────────────────────────────────────────────────────
  // The intake's frequency slider runs 1-7, so these are reachable in the
  // product, not hypotheticals. They bracket the latency range and are where
  // a split heuristic is most likely to produce something silly.
  {
    id: 'onb-general-1d-beginner',
    variant: 'onboarding',
    intake: {
      goal: 'general', experience: 'beginner', frequency: 1,
      gender: 'female', ageYears: 52, heightCm: 161, weightKg: 68,
      targets: { kcal: 1750, protein: 112, carb: 180, fat: 58 },
    },
    // One session a week must be a single full-body workout, not a split.
    expect: { daysPerWeek: 1, minWorkouts: 1, maxWorkouts: 1, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  {
    id: 'onb-hypertrophy-7d-advanced',
    variant: 'onboarding',
    intake: {
      goal: 'hypertrophy', experience: 'advanced', frequency: 7,
      gender: 'male', ageYears: 27, heightCm: 186, weightKg: 95,
      targets: { kcal: 3400, protein: 200, carb: 380, fat: 95 },
    },
    // Upper bound on output tokens, and the strongest test of whether fan-out
    // keeps wall clock flat as plan size grows.
    expect: { daysPerWeek: 7, minWorkouts: 3, maxWorkouts: 7, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
  {
    id: 'onb-fatloss-3d-advanced-female',
    variant: 'onboarding',
    intake: {
      goal: 'fat_loss', experience: 'advanced', frequency: 3,
      gender: 'female', ageYears: 34, heightCm: 170, weightKg: 66,
      goalWeightKg: 60, weeklyRateKg: 0.35, direction: 'loss',
      targets: { kcal: 1720, protein: 138, carb: 150, fat: 54 },
    },
    // Full-body A/B/C at 3 days is the shape where cross-day variant
    // collision is most likely: every session trains the same muscles.
    expect: { daysPerWeek: 3, minWorkouts: 2, maxWorkouts: 3, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 6, minCatalogResolution: 1 },
  },
];

/** Coach-modal cases: real history in context, free-text exercise naming. */
const COACH_CASES: EvalCase[] = [
  {
    id: 'coach-hypertrophy-4d-intermediate',
    variant: 'coach',
    intake: { goal: 'build muscle', days: 4, sessionLength: '60-75 min', level: 'intermediate', userContext: HISTORY_CONTEXT },
    expect: { daysPerWeek: 4, minWorkouts: 3, maxWorkouts: 4, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 8, minCatalogResolution: 0.8 },
  },
  {
    id: 'coach-strength-5d-advanced',
    variant: 'coach',
    intake: { goal: 'get stronger', days: 5, sessionLength: '75-90 min', level: 'advanced', userContext: HISTORY_CONTEXT },
    expect: { daysPerWeek: 5, minWorkouts: 3, maxWorkouts: 5, minExercisesPerWorkout: 4, maxExercisesPerWorkout: 8, minCatalogResolution: 0.8 },
  },
  {
    id: 'coach-returning-3d',
    variant: 'coach',
    intake: {
      goal: 'general fitness', days: 3, sessionLength: '45-60 min', level: 'intermediate',
      userContext: { ...HISTORY_CONTEXT, training_inactive: true, sessions_last_28_days: 0 },
    },
    expect: { daysPerWeek: 3, minWorkouts: 2, maxWorkouts: 3, minExercisesPerWorkout: 3, maxExercisesPerWorkout: 8, minCatalogResolution: 0.8 },
  },
];

export const CASES: EvalCase[] = [...ONBOARDING_CASES, ...COACH_CASES];
