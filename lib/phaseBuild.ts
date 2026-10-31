/**
 * Building a program phase's workouts with Drona.
 *
 * - `phaseBuildSeed` is what the coach sheet's plan screen is opened with: the
 *   phase's split and cadence, so the plan follows the program.
 * - `requestPhasePlan` is the same build without a screen, for the background
 *   build of the next phase (lib/phaseBuildRules.ts decides when). Its answer
 *   goes into the draft store, never straight to routines: the user saves it.
 */
import { track } from '@/lib/analytics';
import { sendWithFreshTokenRetry } from '@/lib/authRetry';
import { structuredToPlan, type GeneratedPlan } from '@/lib/generatedPlan';
import type { ActiveProgramPhaseRow } from '@/lib/programData';
import { writePhaseDraft } from '@/lib/phaseDraft';
import { announceReady } from '@/lib/readyNotice';
import { withBackgroundTime } from '@/lib/backgroundTime';

export interface PhaseBuildSeed {
  goal?: string;
  days?: string;
  note?: string;
}

/** What the plan screen and the background build ask Drona for. */
export function phaseBuildSeed(ph: Pick<ActiveProgramPhaseRow, 'name' | 'training_block' | 'training_directive'>): PhaseBuildSeed {
  const b = ph.training_block;
  const desc = [b?.split_type, b?.emphasis].filter(Boolean).join(', ');
  return {
    goal: b?.emphasis || b?.split_type || undefined,
    note: `Build the training split for the "${ph.name}" phase of my current program${desc ? `: ${desc}` : ''}.${ph.training_directive ? ` ${ph.training_directive}` : ''} Follow that exact split and cadence.`,
  };
}

/**
 * The opening request of an automatic build, where nobody filled in the form:
 * experience and session length come from what Drona already knows about the
 * user (onboarding wrote both), not from the form's defaults.
 */
export function phaseBuildPrompt(note: string): string {
  return `Design my training split. ${note} Use my profile for my experience level and session length; if they are not set, keep sessions about 45-60 minutes. Match that split and cadence exactly, do not convert it into a generic fixed number of days per week. Use my training data for exercise selection, volume, and progression. Give each day a short "note" with its theme and per-exercise cues. Before calling generate_plan, write one short sentence (5-15 words) signaling your intent.`;
}

/**
 * Build a phase's plan in the background and keep it as a draft. Resolves to
 * the plan, or null on any failure (the caller's retry rules decide what next).
 * A 402 is a null too: the server is the gate, this only asks.
 */
export function requestPhasePlan(args: {
  phase: Pick<ActiveProgramPhaseRow, 'id' | 'seq' | 'name' | 'training_block' | 'training_directive'>;
  getToken: (opts?: { skipCache?: boolean }) => Promise<string | null>;
  /** True while the dashboard can show its own ready popup: then no banner on top of it. */
  watching?: () => boolean;
}): Promise<GeneratedPlan | null> {
  // Time to finish if the user leaves the app mid-build (lib/backgroundTime).
  return withBackgroundTime(() => buildPhasePlan(args));
}

async function buildPhasePlan(args: Parameters<typeof requestPhasePlan>[0]): Promise<GeneratedPlan | null> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;
  const seed = phaseBuildSeed(args.phase);
  const startedAt = Date.now();
  try {
    const token = await args.getToken();
    if (!token) return null;
    const send = (t: string) => fetch(`${supabaseUrl}/functions/v1/ai-coach`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: phaseBuildPrompt(seed.note ?? '') }],
        force_tool: 'generate_plan',
        phase_id: args.phase.id,
      }),
    });
    const res = await sendWithFreshTokenRetry(send, token, () => args.getToken({ skipCache: true }));
    if (!res.ok) {
      track('phase_auto_build_failed', { phase_seq: args.phase.seq, status: res.status });
      return null;
    }
    const json = (await res.json()) as { structured?: { name?: string; input?: Record<string, unknown> } };
    const input = json.structured?.name === 'generate_plan' ? json.structured.input : undefined;
    if (!input) {
      track('phase_auto_build_failed', { phase_seq: args.phase.seq, status: 'no_plan' });
      return null;
    }
    const plan = structuredToPlan(input);
    if (plan.workouts.length === 0) return null;
    await writePhaseDraft(args.phase.id, plan, 'auto');
    // Nobody watched this build, so it says when it is ready: a banner, or a
    // notification when the app is in the background. The route is the
    // dashboard card's Review.
    announceReady({
      title: `Your phase ${args.phase.seq + 1} split is ready.`,
      body: 'Tap to look it over and save it.',
      target: { route: `/goal-plan?build=phase&seq=${args.phase.seq}&auto=1` },
      // The dashboard's ready popup files it behind the bell, after the user
      // has seen it, so the card can fly in (components/program/NextPhaseCard).
      inbox: false,
      bannerless: args.watching?.() ?? false,
    });
    track('phase_auto_built', {
      phase_seq: args.phase.seq,
      workouts: plan.workouts.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    return plan;
  } catch (e) {
    console.warn('[phase-build] background build failed', e);
    track('phase_auto_build_failed', { phase_seq: args.phase.seq, status: 'threw' });
    return null;
  }
}
