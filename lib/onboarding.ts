/**
 * First-run onboarding: the done-flag, the "does this user need onboarding?"
 * check, and the starter-plan generator that turns quiz answers into real
 * routines the user can start immediately (the activation moment).
 *
 * Design notes (from onboarding research, July 2026):
 * - The quiz is short (3 taps + 1 optional screen) and every answer visibly
 *   feeds the generated plan, which is what makes users tolerate questions.
 * - The flag is per-identity (clerk id or 'guest') so a guest who later signs
 *   into a brand-new account still gets set up.
 * - Legacy users must NEVER see onboarding on an app update or reinstall:
 *   when the flag is missing we check for existing data (profile fields or
 *   routines) and silently mark done. On a network error we let the user
 *   through WITHOUT setting the flag, so a genuinely-new offline user still
 *   gets onboarding on their next cold start.
 * - Notification / health permissions are deliberately NOT requested here:
 *   the app sends no notifications yet (no expo-notifications dependency), and
 *   health connects contextually from the Health hub. Research is unanimous
 *   that burning the one-shot iOS permission prompt without immediate,
 *   specific value tanks grant rates.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isSupabaseConfigured } from '@/lib/supabase';
import { EXERCISE_LIBRARY } from '@/lib/exercises';
import { Colors } from '@/constants/theme';
import {
  getGuestProfile,
  getGuestRoutines,
  getGuestWorkouts,
  updateGuestProfile,
  addGuestRoutine,
  type GuestRoutine,
  type GuestProfile,
} from '@/lib/guestStore';
import { enqueueRoutine, applyRoutineToCache, type PendingRoutine } from '@/lib/routineQueue';
import { newClientId } from '@/lib/syncQueue';
import type { CoachGoal, ExperienceLevel } from '@/lib/types';

// ─── Answers ─────────────────────────────────────────────────────────────────

export interface OnboardingAnswers {
  goal: CoachGoal | null;
  experience: ExperienceLevel | null;
  /** Target training sessions per week (2..6). */
  frequency: number | null;
  gender: 'M' | 'F' | 'O' | null;
  ageYears: number | null;
  heightCm: number | null;
  weightKg: number | null;
  goalWeightKg: number | null;
}

export const EMPTY_ANSWERS: OnboardingAnswers = {
  goal: null,
  experience: null,
  frequency: null,
  gender: null,
  ageYears: null,
  heightCm: null,
  weightKg: null,
  goalWeightKg: null,
};

// Rough training-age estimate per experience band. Editable in Profile; the
// coach only needs the order of magnitude.
const TRAINING_AGE_MONTHS: Record<ExperienceLevel, number> = {
  beginner: 6,
  intermediate: 24,
  advanced: 60,
};

// ─── Done flag ───────────────────────────────────────────────────────────────

const FLAG_PREFIX = 'overload_onboarding_done::';

export function onboardingIdentity(clerkId: string | null | undefined): string {
  return clerkId || 'guest';
}

export async function markOnboardingDone(identity: string): Promise<void> {
  try {
    await AsyncStorage.setItem(FLAG_PREFIX + identity, '1');
  } catch {
    /* non-fatal: worst case the gate re-checks server data next launch */
  }
}

async function isOnboardingDone(identity: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(FLAG_PREFIX + identity)) === '1';
  } catch {
    return true; // unreadable storage: fail open, never trap the user
  }
}

/**
 * Has onboarding ever been completed on THIS device as a guest? Used by the
 * entry router to tell a truly-fresh install (→ onboarding first) apart from a
 * returning, signed-out visitor (→ auth). Signed-in completions are keyed to a
 * clerkId we can't read while signed out, so those fall through to the fresh
 * path and rely on the welcome screen's "I already have an account" link.
 */
export function hasCompletedGuestOnboarding(): Promise<boolean> {
  return isOnboardingDone(onboardingIdentity(null));
}

/**
 * Should this user be routed through onboarding? Called by the (app) layout
 * gate after the auth guard passes.
 *
 * `client` must be the per-request-auth client from useSupabaseClient(): it
 * THROWS when no Clerk token is available instead of silently querying as
 * anon. An anon query passes RLS as empty rows with NO error, which would
 * misread a legacy signed-in user as brand new here.
 */
export async function resolveNeedsOnboarding(opts: {
  isGuest: boolean;
  clerkId: string | null;
  client: SupabaseClient;
}): Promise<boolean> {
  const identity = onboardingIdentity(opts.isGuest ? null : opts.clerkId);
  if (await isOnboardingDone(identity)) return false;

  if (opts.isGuest || !opts.clerkId) {
    // Guest data is local and already hydrated at app boot, so this is sync.
    const p = getGuestProfile();
    const hasData =
      !!p.goal || !!p.experience_level || getGuestRoutines().length > 0 || getGuestWorkouts().length > 0;
    if (hasData) {
      await markOnboardingDone(identity);
      return false;
    }
    return true;
  }

  // Signed-in with no local flag: fresh install or pre-onboarding account.
  // Look for existing data before showing onboarding to a legacy user.
  if (!isSupabaseConfigured) return false;
  try {
    const [{ data: profile, error: pErr }, { count: routineCount, error: rErr }, { count: workoutCount, error: wErr }] = await Promise.all([
      opts.client
        .from('user_profiles')
        .select('goal, experience_level, weekly_target_sessions, training_age_months, gender, height_cm, weight_kg, goal_weight_kg, body_fat_percent, date_of_birth')
        .eq('clerk_user_id', opts.clerkId)
        .maybeSingle(),
      opts.client
        .from('routines')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', opts.clerkId),
      opts.client
        .from('workouts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', opts.clerkId),
    ]);
    if (pErr || rErr || wErr) throw pErr || rErr || wErr;
    const hasData =
      !!profile?.goal || !!profile?.experience_level || !!profile?.weekly_target_sessions
      || profile?.training_age_months != null || profile?.gender != null || profile?.height_cm != null
      || profile?.weight_kg != null || profile?.goal_weight_kg != null || profile?.body_fat_percent != null
      || profile?.date_of_birth != null || (routineCount ?? 0) > 0 || (workoutCount ?? 0) > 0;
    if (hasData) {
      await markOnboardingDone(identity);
      return false;
    }
    return true;
  } catch {
    // Offline / transient failure: let the user through, re-check next launch.
    return false;
  }
}

// ─── Daily nutrition targets (the diet half of the intake payoff) ───────────

export interface DailyTargets {
  kcal: number;
  protein: number;
  carb: number;
  fat: number;
}

// Sedentary base plus the lift days the user committed to. Lifting is not
// cardio, so these stay conservative; the targets are a starting point the
// nutrition screen lets the user edit.
function activityFactor(frequency: number): number {
  if (frequency <= 3) return 1.4;
  if (frequency <= 5) return 1.5;
  return 1.6;
}

// Calorie adjustment by goal. When the goal itself is direction-neutral
// (general, endurance) but the user named a target weight, lean the budget
// toward that direction instead.
function goalAdjustment(a: OnboardingAnswers): number {
  switch (a.goal) {
    case 'fat_loss': return 0.8;
    case 'hypertrophy': return 1.1;
    case 'strength': return 1.05;
    default: {
      if (a.goalWeightKg && a.weightKg) {
        const diff = a.goalWeightKg - a.weightKg;
        if (diff < -2) return 0.85;
        if (diff > 2) return 1.05;
      }
      return 1.0;
    }
  }
}

const PROTEIN_G_PER_KG: Record<CoachGoal, number> = {
  fat_loss: 2.0,
  hypertrophy: 1.8,
  strength: 1.8,
  endurance: 1.6,
  general: 1.6,
};

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/** Mifflin-St Jeor BMR; null when weight or age were not provided. Height
 *  falls back to a population median (a ~±60 kcal term). */
function bmrOf(a: OnboardingAnswers): number | null {
  if (!a.weightKg || a.weightKg <= 0 || !a.ageYears || a.ageYears <= 0) return null;
  const h = a.heightCm && a.heightCm > 0 ? a.heightCm : a.gender === 'F' ? 162 : 172;
  const genderTerm = a.gender === 'M' ? 5 : a.gender === 'F' ? -161 : -78;
  return 10 * a.weightKg + 6.25 * h - 5 * a.ageYears + genderTerm;
}

/** Protein-first macro split shared by every targets path. */
function macroSplit(kcal: number, a: OnboardingAnswers): DailyTargets {
  const protein = roundTo((a.weightKg ?? 0) * PROTEIN_G_PER_KG[a.goal ?? 'general'], 5);
  const fat = Math.max(40, roundTo((kcal * 0.25) / 9, 5));
  const carb = Math.max(0, roundTo((kcal - protein * 4 - fat * 9) / 4, 5));
  return { kcal, protein, carb, fat };
}

/** Maintenance calories (BMR x activity), before any goal adjustment. */
export function maintenanceKcal(a: OnboardingAnswers): number | null {
  const bmr = bmrOf(a);
  if (bmr == null) return null;
  return roundTo(bmr * activityFactor(a.frequency ?? 3), 25);
}

/**
 * Mifflin-St Jeor BMR x activity x goal adjustment, split into the app's
 * protein-first macro framing. Needs weight and age; everything is editable on
 * the nutrition screen. Returns null when the inputs were skipped, so the plan
 * screen can say "add your stats later" instead of inventing numbers.
 */
export function computeDailyTargets(a: OnboardingAnswers): DailyTargets | null {
  const bmr = bmrOf(a);
  if (bmr == null) return null;
  const kcal = Math.max(1200, roundTo(bmr * activityFactor(a.frequency ?? 3) * goalAdjustment(a), 25));
  return macroSplit(kcal, a);
}

// ─── Pace (Phase 2: target + pace step) ─────────────────────────────────────
// Real energy-balance math instead of the coarse goal factor: the user picks a
// weekly rate, we convert it to a daily calorie delta and a projected date.

export const KCAL_PER_KG = 7700;

export interface PaceBounds {
  min: number;
  max: number;
  recommended: number;
}

/** Weekly-rate bounds by direction, with the recommended default at ~0.5% of
 *  bodyweight per week for a cut and ~0.25% for a build (rounded to 0.05). */
export function paceBounds(direction: 'loss' | 'gain', weightKg: number): PaceBounds {
  const pct = direction === 'loss' ? 0.005 : 0.0025;
  const min = 0.1;
  const max = direction === 'loss' ? 1.0 : 0.5;
  const recommended = Math.min(max, Math.max(min, Math.round(((weightKg * pct) / 0.05)) * 0.05));
  return { min, max, recommended: Math.round(recommended * 100) / 100 };
}

/**
 * Daily targets for a chosen pace: maintenance minus (cut) or plus (build) the
 * daily calorie equivalent of the weekly rate. Never below the 1200 floor.
 * Null when body stats are missing or there is no weight direction.
 */
export function paceAdjustedTargets(
  a: OnboardingAnswers,
  weeklyRateKg: number,
): DailyTargets | null {
  const maintenance = maintenanceKcal(a);
  if (maintenance == null || !a.weightKg || !a.goalWeightKg) return null;
  const diff = a.goalWeightKg - a.weightKg;
  if (Math.abs(diff) < 1) return null; // holding steady: no pace to apply
  const dailyDelta = (weeklyRateKg * KCAL_PER_KG) / 7;
  const kcal = Math.max(
    1200,
    roundTo(diff < 0 ? maintenance - dailyDelta : maintenance + dailyDelta, 25),
  );
  return macroSplit(kcal, a);
}

/** ISO date (yyyy-mm-dd) when the goal weight lands at the chosen pace. */
export function projectGoalDateIso(
  a: OnboardingAnswers,
  weeklyRateKg: number,
): string | null {
  if (!a.weightKg || !a.goalWeightKg || weeklyRateKg <= 0) return null;
  const diffKg = Math.abs(a.goalWeightKg - a.weightKg);
  if (diffKg < 1) return null;
  const weeks = diffKg / weeklyRateKg;
  const d = new Date();
  d.setDate(d.getDate() + Math.round(weeks * 7));
  return d.toISOString().slice(0, 10);
}

// ─── Profile save ────────────────────────────────────────────────────────────

/** Approximate DOB from an age in years (today's month/day). The coach only
 *  needs age_years; the exact date is editable in Profile. */
function dobFromAge(ageYears: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - ageYears);
  return d.toISOString().slice(0, 10);
}

/**
 * Persist quiz answers (and computed nutrition targets) to the profile.
 * Best-effort: a failure never blocks finishing onboarding (every field is
 * editable in Profile / the nutrition screen later). Guests get everything
 * except nutrition targets, which currently have no guest-side store — the
 * nutrition screen reads them from user_profiles only.
 */
export async function saveOnboardingProfile(
  answers: OnboardingAnswers,
  targets: DailyTargets | null,
  opts: { isGuest: boolean; clerkId: string | null; client: SupabaseClient },
): Promise<void> {
  const patch: Partial<GuestProfile> = {};
  if (answers.goal) patch.goal = answers.goal;
  if (answers.experience) {
    patch.experience_level = answers.experience;
    patch.training_age_months = TRAINING_AGE_MONTHS[answers.experience];
  }
  if (answers.frequency) patch.weekly_target_sessions = answers.frequency;
  if (answers.gender) patch.gender = answers.gender;
  if (answers.ageYears && answers.ageYears > 0) patch.date_of_birth = dobFromAge(answers.ageYears);
  if (answers.heightCm && answers.heightCm > 0) patch.height_cm = answers.heightCm;
  if (answers.weightKg && answers.weightKg > 0) patch.weight_kg = answers.weightKg;
  if (answers.goalWeightKg && answers.goalWeightKg > 0) patch.goal_weight_kg = answers.goalWeightKg;

  if (opts.isGuest || !opts.clerkId) {
    if (Object.keys(patch).length > 0) updateGuestProfile(patch);
    return;
  }
  if (!isSupabaseConfigured) return;
  const row: Record<string, unknown> = { clerk_user_id: opts.clerkId, ...patch };
  if (targets) {
    row.daily_calorie_target = targets.kcal;
    row.protein_target_g = targets.protein;
    row.carb_target_g = targets.carb;
    row.fat_target_g = targets.fat;
  }
  if (Object.keys(row).length === 1) return; // nothing beyond the id
  try {
    await opts.client
      .from('user_profiles')
      .upsert(row, { onConflict: 'clerk_user_id' });
  } catch {
    /* best-effort; see docstring */
  }
}

// ─── Starter plan generator ──────────────────────────────────────────────────

export interface StarterRoutineExercise {
  name: string;
  muscle_group: string;
  category: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number;
}

export interface StarterRoutine {
  name: string;
  description: string;
  color: string;
  exercises: StarterRoutineExercise[];
}

interface TemplateExercise {
  name: string;
  compound: boolean;
}

interface Template {
  name: string;
  description: string;
  exercises: TemplateExercise[];
}

// All names must exist in EXERCISE_LIBRARY so the sync queue resolves them to
// the seeded catalog rows by name (never creating near-duplicate customs).
const c = (name: string): TemplateExercise => ({ name, compound: true });
const i = (name: string): TemplateExercise => ({ name, compound: false });

const FULL_BODY: Template[] = [
  {
    name: 'Full Body A',
    description: 'Starter plan. Alternate with Full Body B.',
    exercises: [c('Squat'), c('Bench Press'), c('Barbell Row'), i('Lateral Raise'), i('Ab Crunch')],
  },
  {
    name: 'Full Body B',
    description: 'Starter plan. Alternate with Full Body A.',
    exercises: [c('Romanian Deadlift'), c('Overhead Press'), c('Lat Pulldown'), i('Dumbbell Curl'), i('Hanging Leg Raise')],
  },
];

const UPPER_LOWER: Template[] = [
  {
    name: 'Upper Body',
    description: 'Starter plan. Alternate with Lower Body.',
    exercises: [c('Bench Press'), c('Barbell Row'), c('Overhead Press'), c('Lat Pulldown'), i('Dumbbell Curl'), i('Tricep Pushdown')],
  },
  {
    name: 'Lower Body',
    description: 'Starter plan. Alternate with Upper Body.',
    exercises: [c('Squat'), c('Romanian Deadlift'), c('Leg Press'), i('Leg Curl'), i('Calf Raise'), i('Ab Crunch')],
  },
];

const PPL: Template[] = [
  {
    name: 'Push',
    description: 'Starter plan. Rotate Push, Pull, Legs.',
    exercises: [c('Bench Press'), c('Overhead Press'), c('Incline Dumbbell Press'), i('Lateral Raise'), i('Tricep Pushdown')],
  },
  {
    name: 'Pull',
    description: 'Starter plan. Rotate Push, Pull, Legs.',
    exercises: [c('Deadlift'), c('Lat Pulldown'), c('Barbell Row'), i('Face Pull'), i('Dumbbell Curl')],
  },
  {
    name: 'Legs',
    description: 'Starter plan. Rotate Push, Pull, Legs.',
    exercises: [c('Squat'), c('Romanian Deadlift'), c('Leg Press'), i('Leg Curl'), i('Calf Raise')],
  },
];

// Rep range + rest per goal, split by compound vs isolation (strength-style
// 4-6 rep prescriptions only make sense on compounds; isolations stay in a
// moderate range regardless of goal).
const PRESCRIPTION: Record<CoachGoal, { comp: [number, number, number]; iso: [number, number, number] }> = {
  //          [reps_min, reps_max, rest_seconds]
  strength: { comp: [4, 6, 180], iso: [8, 12, 90] },
  hypertrophy: { comp: [6, 10, 120], iso: [10, 15, 75] },
  fat_loss: { comp: [8, 12, 90], iso: [12, 15, 60] },
  endurance: { comp: [12, 15, 60], iso: [15, 20, 45] },
  general: { comp: [8, 12, 90], iso: [10, 15, 60] },
};

const SETS_BY_EXPERIENCE: Record<ExperienceLevel, { comp: number; iso: number }> = {
  beginner: { comp: 3, iso: 2 },
  intermediate: { comp: 3, iso: 3 },
  advanced: { comp: 4, iso: 3 },
};

export function splitNameFor(frequency: number | null): string {
  const f = frequency ?? 3;
  if (f <= 3) return 'Full Body';
  if (f === 4) return 'Upper / Lower';
  return 'Push / Pull / Legs';
}

/**
 * Turn quiz answers into concrete starter routines. Pure: no writes. Unanswered
 * questions fall back to sensible defaults (general goal, 3 days, beginner
 * volume) so a skip-happy user still gets a real plan.
 */
export function buildStarterRoutines(answers: OnboardingAnswers): StarterRoutine[] {
  const goal: CoachGoal = answers.goal ?? 'general';
  const experience: ExperienceLevel = answers.experience ?? 'beginner';
  const frequency = answers.frequency ?? 3;

  const templates = frequency <= 3 ? FULL_BODY : frequency === 4 ? UPPER_LOWER : PPL;
  const rx = PRESCRIPTION[goal];
  const sets = SETS_BY_EXPERIENCE[experience];

  return templates.map((t, idx) => ({
    name: t.name,
    description: t.description,
    color: Colors.routineColors[idx % Colors.routineColors.length],
    exercises: t.exercises
      .map((te) => {
        const lib = EXERCISE_LIBRARY.find((e) => e.name === te.name);
        if (!lib) return null; // defensive: template drifted from the library
        const [reps_min, reps_max, rest_seconds] = te.compound ? rx.comp : rx.iso;
        return {
          name: lib.name,
          muscle_group: lib.muscle_group,
          category: lib.category,
          sets: te.compound ? sets.comp : sets.iso,
          reps_min,
          reps_max,
          rest_seconds,
        };
      })
      .filter((e): e is StarterRoutineExercise => e !== null),
  }));
}

/**
 * Write the starter routines through the app's normal local-first paths:
 * guest store for guests, the offline routine queue for signed-in users (the
 * queue resolves exercises to catalog rows by name once online). The caller
 * should fire useSync().flushNow() afterwards to sync immediately when online.
 */
export async function createStarterRoutines(
  routines: StarterRoutine[],
  opts: { isGuest: boolean; clerkId: string | null },
): Promise<void> {
  const now = Date.now();

  // Both write paths PREPEND (addGuestRoutine unshifts; enqueueRoutine +
  // applyRoutineToCache put the newest entry first), so create in reverse:
  // the last write is day A, which then leads every list. created_at is
  // staggered the same way so the server's created_at-desc ordering agrees
  // once the queue flushes.
  const reversed = [...routines].map((r, idx) => ({ r, idx })).reverse();

  if (opts.isGuest || !opts.clerkId) {
    reversed.forEach(({ r, idx }) => {
      const routineId = `guest-r-${now}-${idx}`;
      const guestRoutine: GuestRoutine = {
        id: routineId,
        user_id: 'guest',
        name: r.name,
        description: r.description,
        color: r.color,
        // Stagger timestamps DESCENDING down the list so created_at-desc
        // ordering shows day A first.
        created_at: new Date(now - idx * 1000).toISOString(),
        routine_exercises: r.exercises.map((ex, i2) => {
          const exId = `guest-ex-${now}-${idx}-${i2}`;
          return {
            id: `gre-${now}-${idx}-${i2}`,
            exercise_id: exId,
            order: i2,
            sets: ex.sets,
            reps_min: ex.reps_min,
            reps_max: ex.reps_max,
            rest_seconds: ex.rest_seconds,
            superset_group: null,
            exercises: {
              id: exId,
              name: ex.name,
              muscle_group: ex.muscle_group,
              category: ex.category,
            },
          };
        }),
      };
      addGuestRoutine(guestRoutine);
    });
    return;
  }

  const clerkId = opts.clerkId;
  for (const { r, idx } of reversed) {
    const entry: PendingRoutine = {
      schema: 1,
      routineId: newClientId(),
      ownerId: clerkId,
      name: r.name,
      description: r.description,
      color: r.color,
      createdAtIso: new Date(now - idx * 1000).toISOString(),
      exercises: r.exercises.map((ex, i2) => ({
        def: { name: ex.name, muscle_group: ex.muscle_group, category: ex.category },
        resolvedExerciseId: null, // resolve by name against the seeded catalog
        order: i2,
        sets: ex.sets,
        reps_min: ex.reps_min,
        reps_max: ex.reps_max,
        rest_seconds: ex.rest_seconds,
        note: null,
        superset_group: null,
      })),
      phase: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: now - idx,
    };
    applyRoutineToCache(clerkId, entry);
    await enqueueRoutine(clerkId, entry);
  }
}
