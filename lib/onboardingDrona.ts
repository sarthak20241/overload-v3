/**
 * Drona-generated onboarding plans (Phase 3b). The build moment fires ONE
 * call to the ai-coach edge function with force_tool: 'generate_plan'
 * (non-streaming) and a single intake message carrying everything the quiz
 * collected. The structured tool output is validated and mapped into the
 * same StarterRoutine[] shape the deterministic engine produces, so the
 * reveal and save paths don't care which author won.
 *
 * The deterministic engine (buildStarterRoutines) stays as the fallback and
 * sanity check: any network error, malformed output, or plan that fails
 * validation quietly falls back. The user never sees a failure state during
 * onboarding; worst case they get the curated starter plan.
 */
import { EXERCISE_LIBRARY } from '@/lib/exercises';
import { Colors } from '@/constants/theme';
import type { CoachGoal, ExperienceLevel } from '@/lib/types';
import type { OnboardingAnswers, StarterRoutine, StarterRoutineExercise } from '@/lib/onboarding';

// Generation can legitimately take 15-30 s (the build screen is elastic by
// design and simply holds the thinking state). This cap only guards against
// a hung connection, not a slow model.
const REQUEST_TIMEOUT_MS = 75_000;

const GOAL_LABEL: Record<CoachGoal, string> = {
  hypertrophy: 'build muscle',
  strength: 'get stronger',
  fat_loss: 'lose fat',
  endurance: 'build endurance',
  general: 'general fitness',
};

// ─── Intake message ──────────────────────────────────────────────────────────

/**
 * One self-contained user message. The catalog list grounds exercise naming:
 * every emitted name must resolve against EXERCISE_LIBRARY so the sync queue
 * maps to seeded rows instead of spawning near-duplicate customs.
 */
export function buildOnboardingIntakeMessage(
  answers: OnboardingAnswers,
  extras: {
    weeklyRateKg: number | null;
    direction: 'loss' | 'gain' | null;
    /** The computed daily fuel targets the reveal will show. Passing them in
     * keeps Drona's rationale from quoting different numbers than the card. */
    targets: { kcal: number; protein: number; carb: number; fat: number } | null;
  },
): string {
  const goal: CoachGoal = answers.goal ?? 'general';
  const experience: ExperienceLevel = answers.experience ?? 'beginner';
  const frequency = answers.frequency ?? 3;

  const catalog = EXERCISE_LIBRARY.map((e) => e.name).join('; ');

  const bodyFacts: string[] = [];
  if (answers.gender) bodyFacts.push(`sex ${answers.gender}`);
  if (answers.ageYears) bodyFacts.push(`${answers.ageYears} years old`);
  if (answers.heightCm) bodyFacts.push(`${answers.heightCm} cm`);
  if (answers.weightKg) bodyFacts.push(`${answers.weightKg} kg`);
  if (answers.goalWeightKg && extras.direction) {
    bodyFacts.push(
      `target weight ${answers.goalWeightKg} kg (${extras.direction === 'loss' ? 'cutting' : 'gaining'}${
        extras.weeklyRateKg ? ` at ${extras.weeklyRateKg} kg/week` : ''
      })`,
    );
  }

  return [
    `I just finished onboarding. Build my starter training plan from these answers.`,
    `Goal: ${GOAL_LABEL[goal]}. Experience: ${experience}. Training ${frequency} days a week.`,
    bodyFacts.length ? `Body: ${bodyFacts.join(', ')}.` : '',
    extras.targets
      ? `My daily fuel targets are already set: ${extras.targets.kcal} kcal, ${extras.targets.protein}g protein, ${extras.targets.carb}g carbs, ${extras.targets.fat}g fat. If you mention nutrition, use exactly these numbers.`
      : '',
    `Rules:`,
    `- days_per_week is ${frequency}. Create the number of DISTINCT workouts that a ${experience} lifter should rotate through ${frequency} sessions a week (fewer distinct workouts than sessions is fine, they repeat). Typical: 1-3 days full body A/B, 4 days upper/lower, 5+ push/pull/legs. Deviate only if it genuinely fits better.`,
    `- Exercise names MUST be copied character-for-character from this catalog, nothing else: ${catalog}.`,
    `- 4-6 exercises per workout, compounds first. Sets 2-4, plain rep ranges like "6-10", rest 45-180 seconds.`,
    `- Short workout names ("Full Body A", "Push Day"). One-line note per workout with its focus.`,
    `- The rationale should read like you talking to me: why this split at ${frequency} days for my goal, and how to progress. 3-4 sentences, no lists.`,
    `This is a fresh account, so skip data-lookup tools and emit generate_plan directly.`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── Edge call ───────────────────────────────────────────────────────────────

interface GeneratePlanInput {
  name?: unknown;
  split_type?: unknown;
  rationale?: unknown;
  workouts?: unknown;
}

/**
 * Non-streaming call. Resolves with the raw generate_plan tool input, or
 * throws (network, HTTP, missing structured output). Callers race this
 * against the fallback decision; they never surface the error to the user.
 */
export async function requestDronaOnboardingPlan(args: {
  token: string;
  message: string;
}): Promise<GeneratePlanInput> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error('Supabase not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/ai-coach`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.token}`,
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: args.message }],
        force_tool: 'generate_plan',
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as {
      structured?: { name?: string; input?: GeneratePlanInput } | null;
    };
    const input = json.structured?.name === 'generate_plan' ? json.structured.input : null;
    if (!input) throw new Error('No structured plan in response');
    return input;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Validation + mapping ────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** "6-10" → [6, 10]; "5" → [5, 5]; anything fancier falls back to 8-12. */
function parseReps(reps: unknown): [number, number] {
  if (typeof reps === 'number' && Number.isFinite(reps)) {
    const n = clamp(Math.round(reps), 1, 30);
    return [n, n];
  }
  if (typeof reps === 'string') {
    const range = reps.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
    if (range) {
      const lo = clamp(parseInt(range[1], 10), 1, 30);
      const hi = clamp(parseInt(range[2], 10), lo, 30);
      return [lo, hi];
    }
    const single = reps.match(/^\s*(\d{1,2})\s*$/);
    if (single) {
      const n = clamp(parseInt(single[1], 10), 1, 30);
      return [n, n];
    }
  }
  return [8, 12];
}

// Case/whitespace-insensitive catalog index.
const LIBRARY_INDEX = new Map(
  EXERCISE_LIBRARY.map((e) => [e.name.toLowerCase().replace(/\s+/g, ' ').trim(), e]),
);

export interface DronaOnboardingPlan {
  routines: StarterRoutine[];
  /** Drona's own words on why this plan, for the reveal's coach card. */
  rationale: string | null;
}

/**
 * Validate + map the tool output. Returns null when the plan doesn't hold up
 * (too few resolvable exercises, no workouts, absurd volume), which callers
 * treat as "use the deterministic plan".
 */
export function dronaPlanToStarterRoutines(input: GeneratePlanInput): DronaOnboardingPlan | null {
  if (!Array.isArray(input.workouts) || input.workouts.length < 1 || input.workouts.length > 7) {
    return null;
  }

  let emitted = 0;
  let resolved = 0;
  const routines: StarterRoutine[] = [];

  for (const [idx, raw] of (input.workouts as unknown[]).entries()) {
    if (typeof raw !== 'object' || raw === null) return null;
    const w = raw as { name?: unknown; note?: unknown; exercises?: unknown };
    const wName = typeof w.name === 'string' && w.name.trim() ? w.name.trim().slice(0, 60) : null;
    if (!wName || !Array.isArray(w.exercises)) return null;

    const exercises: StarterRoutineExercise[] = [];
    for (const rawEx of w.exercises as unknown[]) {
      emitted += 1;
      if (typeof rawEx !== 'object' || rawEx === null) continue;
      const ex = rawEx as { name?: unknown; sets?: unknown; reps?: unknown; rest_seconds?: unknown };
      if (typeof ex.name !== 'string') continue;
      const lib = LIBRARY_INDEX.get(ex.name.toLowerCase().replace(/\s+/g, ' ').trim());
      if (!lib) continue; // hallucinated name: drop, don't invent customs
      resolved += 1;
      const [reps_min, reps_max] = parseReps(ex.reps);
      exercises.push({
        name: lib.name,
        muscle_group: lib.muscle_group,
        category: lib.category,
        sets: clamp(typeof ex.sets === 'number' ? Math.round(ex.sets) : 3, 1, 5),
        reps_min,
        reps_max,
        rest_seconds: clamp(
          typeof ex.rest_seconds === 'number' ? Math.round(ex.rest_seconds) : 90,
          30,
          300,
        ),
      });
    }

    // A workout that lost too many exercises to name resolution isn't the
    // plan Drona designed; scrap the whole thing rather than ship a stub.
    if (exercises.length < 3) return null;
    routines.push({
      name: wName,
      description:
        typeof w.note === 'string' && w.note.trim() ? w.note.trim().slice(0, 120) : 'Coached by Drona.',
      color: Colors.routineColors[idx % Colors.routineColors.length],
      exercises: exercises.slice(0, 8),
    });
  }

  // Wholesale integrity check: if more than 30% of what Drona wrote didn't
  // resolve, the plan we'd save isn't the plan it reasoned about.
  if (emitted === 0 || resolved / emitted < 0.7) return null;

  return {
    routines,
    rationale:
      typeof input.rationale === 'string' && input.rationale.trim()
        ? input.rationale.trim()
        : null,
  };
}
