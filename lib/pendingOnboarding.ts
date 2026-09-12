/**
 * Guest-first onboarding funnel: the bridge between "finished the intake" and
 * "have an identity to save it under."
 *
 * A fresh visitor runs the whole intake with NO account, so at the reveal we
 * can't save yet - there's no clerkId, and writing to the guest store now
 * would strand the plan there (no guest->account migration exists). Instead we
 * stash the finished intake here and send the user to the auth screen. Once
 * they resolve an identity (sign in OR continue as guest), the (app) layout
 * drains this blob and saves the plan under whoever they became. The save
 * simply happens AFTER identity is known rather than before, which is what
 * makes "onboarding first, then sign in" work without a migration.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { saveBasicInfo } from '@/lib/bodyStats';
import {
  createStarterRoutines,
  markOnboardingDone,
  onboardingIdentity,
  saveOnboardingProfile,
  type DailyTargets,
  type OnboardingAnswers,
  type StarterRoutine,
} from '@/lib/onboarding';
import { saveProgram, type GeneratedProgram } from '@/lib/programData';

const PENDING_KEY = 'pending_onboarding_v1';

export interface PendingOnboarding {
  answers: OnboardingAnswers;
  targets: DailyTargets | null;
  /** The generated (or deterministic) plan, already resolved to catalog rows. */
  plan: StarterRoutine[];
  /** The goal program (phases to the target). Saved only under a real account;
   *  guests have no program store. Older blobs predate the field. */
  program?: GeneratedProgram | null;
  /** Whether to actually create the routines, or just save the profile. */
  createPlan: boolean;
  /** Where to land after the plan is drained under the resolved identity. */
  dest: '/(app)' | '/(app)/routines';
  weightUnit: 'kg' | 'lbs';
  goalWeightKg: number | null;
}

export async function setPendingOnboarding(blob: PendingOnboarding): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(blob));
  } catch {
    /* best-effort; if this fails the user just lands on auth with no saved plan */
  }
}

export async function hasPendingOnboarding(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PENDING_KEY)) != null;
  } catch {
    return false;
  }
}

async function getPendingOnboarding(): Promise<PendingOnboarding | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingOnboarding) : null;
  } catch {
    return null;
  }
}

export async function clearPendingOnboarding(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Consume any pending intake and save it under the now-resolved identity.
 * Idempotent and safe to call on every (app) mount: no-ops when nothing is
 * pending. Clears the blob only after a successful save so a mid-save crash
 * leaves it to retry next launch. Returns the intended landing route when a
 * plan was drained (the caller skips the first-run check and routes there), or
 * null when nothing was pending.
 */
export async function drainPendingOnboarding(target: {
  isGuest: boolean;
  clerkId: string | null;
  client: SupabaseClient;
}): Promise<PendingOnboarding['dest'] | null> {
  const pending = await getPendingOnboarding();
  if (!pending) return null;

  const identity = onboardingIdentity(target.isGuest ? null : target.clerkId);
  await saveOnboardingProfile(pending.answers, pending.targets, target);
  if (pending.weightUnit) await saveBasicInfo({ weightUnit: pending.weightUnit });
  if (pending.goalWeightKg && pending.goalWeightKg > 0) {
    await saveBasicInfo({ goalWeight: pending.goalWeightKg });
  }
  const phaseId = pending.createPlan && pending.program
    ? await saveOnboardingProgram(pending.program, target)
    : null;
  if (pending.createPlan && pending.plan.length > 0) {
    await createStarterRoutines(pending.plan, { ...target, programPhaseId: phaseId });
  }
  await markOnboardingDone(identity);
  await clearPendingOnboarding();
  return pending.dest ?? '/(app)';
}

/**
 * Save the onboarding program under a real account and return phase 1's id
 * (so the starter routines can be linked to it). Guests get nothing here; the
 * Goal & Plan screen already needs a Clerk id.
 *
 * Best-effort by design, and deliberately not retried. Blocking the finish
 * line on this insert would trap the user behind a network blip holding a
 * plan they cannot reach, which is the worse failure. The program is also
 * the one artifact with a first-class path back: losing it lands the user on
 * Goal & Plan's "No program yet / Build a program" empty state, one tap from
 * the dashboard's Goal button, which rebuilds it with the coach. That is the
 * recovery, so a silent null here costs a detour, not the feature.
 */
export async function saveOnboardingProgram(
  program: GeneratedProgram,
  target: { isGuest: boolean; clerkId: string | null; client: SupabaseClient },
): Promise<string | null> {
  if (target.isGuest || !target.clerkId) return null;
  try {
    const { phaseIds } = await saveProgram(target.client, target.clerkId, program);
    return phaseIds[0] ?? null;
  } catch (e) {
    console.warn('[onboarding] program save failed; routines save unlinked', e);
    return null;
  }
}
