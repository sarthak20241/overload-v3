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

const PENDING_KEY = 'pending_onboarding_v1';

export interface PendingOnboarding {
  answers: OnboardingAnswers;
  targets: DailyTargets | null;
  /** The generated (or deterministic) plan, already resolved to catalog rows. */
  plan: StarterRoutine[];
  /** Whether to actually create the routines, or just save the profile. */
  createPlan: boolean;
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
 * leaves it to retry next launch. Returns true when a plan was drained (the
 * caller can then skip the first-run onboarding check).
 */
export async function drainPendingOnboarding(target: {
  isGuest: boolean;
  clerkId: string | null;
  client: SupabaseClient;
}): Promise<boolean> {
  const pending = await getPendingOnboarding();
  if (!pending) return false;

  const identity = onboardingIdentity(target.isGuest ? null : target.clerkId);
  await saveOnboardingProfile(pending.answers, pending.targets, target);
  if (pending.weightUnit) await saveBasicInfo({ weightUnit: pending.weightUnit });
  if (pending.goalWeightKg && pending.goalWeightKg > 0) {
    await saveBasicInfo({ goalWeight: pending.goalWeightKg });
  }
  if (pending.createPlan && pending.plan.length > 0) {
    await createStarterRoutines(pending.plan, target);
  }
  await markOnboardingDone(identity);
  await clearPendingOnboarding();
  return true;
}
