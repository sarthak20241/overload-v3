/**
 * Drona-generated onboarding PROGRAM (the phase-by-phase road to the goal).
 *
 * The build moment fires one non-streaming call to the ai-coach edge function
 * with generate_program forced. Guests go through the anonymous, device-rate-
 * limited route; a signed-in re-onboarding goes through the authenticated one.
 *
 * The week of concrete workouts is NOT generated here. It used to be, in a
 * second forced generate_plan call, which meant one onboarding bought two
 * model calls and the routines were saved before there was a user id to own
 * them. The split is now built after sign-up from the Goal screen, against the
 * real account. Until that build runs, the account has no routines at all:
 * a deliberate trade, so a generic starter week never sits beside the real
 * split looking like a second plan. The dashboard asks for the build.
 *
 * Any network error, malformed output or failed validation quietly falls back
 * to the deterministic program. The user never sees a failure state.
 */
import type { OnboardingAnswers } from '@/lib/onboarding';

// Generation can legitimately take 15-30 s (the build screen is elastic by
// design and simply holds the thinking state). This cap only guards against
// a hung connection, not a slow model.
const REQUEST_TIMEOUT_MS = 75_000;


/** The structured intake the anonymous route accepts. No free prompt text:
 * the edge builds the message server-side from exactly these fields. */
export interface AnonIntake {
  goal: string | null;
  experience: string | null;
  frequency: number | null;
  gender: string | null;
  ageYears: number | null;
  heightCm: number | null;
  weightKg: number | null;
  goalWeightKg: number | null;
  weeklyRateKg: number | null;
  direction: 'loss' | 'gain' | null;
  targets: { kcal: number; protein: number; carb: number; fat: number } | null;
  /** Optional free text; the edge sanitizes and length-caps it before use. */
  healthNotes: string | null;
  routinePrefs: string | null;
}

export function buildAnonIntake(
  answers: OnboardingAnswers,
  extras: {
    weeklyRateKg: number | null;
    direction: 'loss' | 'gain' | null;
    targets: { kcal: number; protein: number; carb: number; fat: number } | null;
  },
): AnonIntake {
  return {
    goal: answers.goal,
    experience: answers.experience,
    frequency: answers.frequency,
    gender: answers.gender,
    ageYears: answers.ageYears,
    heightCm: answers.heightCm,
    weightKg: answers.weightKg,
    goalWeightKg: answers.goalWeightKg,
    weeklyRateKg: extras.weeklyRateKg,
    direction: extras.direction,
    targets: extras.targets,
    healthNotes: answers.healthNotes,
    routinePrefs: answers.routinePrefs,
  };
}

/**
 * Anonymous variant: a fresh visitor gets their goal PROGRAM with no account.
 * Sends only structured intake (never free prompt text) plus a device id; the
 * edge builds the message server-side, rate-limits, and forces
 * generate_program. Throws like the authenticated variant so callers fall back
 * to the deterministic program on any error (including a 429 rate-limit).
 *
 * The week of workouts is NOT generated here any more. It is built after
 * sign-up, from the Goal screen, so it lands against a real user id.
 */
export async function requestAnonOnboardingProgram(args: {
  deviceId: string;
  intake: AnonIntake;
}): Promise<Record<string, unknown>> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error('Supabase not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/ai-coach`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'onboarding_plan',
        device_id: args.deviceId,
        intake: args.intake,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as {
      program?: { name?: string; input?: Record<string, unknown> } | null;
    };
    const program = json.program?.name === 'generate_program' ? json.program.input : null;
    if (!program) throw new Error('No program in response');
    return program;
  } finally {
    clearTimeout(timeout);
  }
}
