/**
 * Client side of the form-check edge function.
 *
 * Two calls, both small: `requestFormNote` sends the angle summary and gets
 * Drona's write-up back, and `requestAuthoredRules` asks for a rule spec for a
 * movement the catalog has never seen. Neither ever sends video, frames or
 * keypoints; see lib/form/summarize.ts for exactly what leaves the device.
 */

import { FunctionRegion, type SupabaseClient } from '@supabase/supabase-js';

import { coachInvokeErrorMessage } from '@/lib/coachErrors';
import type { FormSummary, UnusableReason } from './summarize';

export interface FormNote {
  id: string | null;
  createdAt: string | null;
  note: string;
  headline: string | null;
  /** Cue id the lifter should focus on next set, when there is one. */
  focus: string | null;
  score: number;
}

export type FormNoteResult =
  | { kind: 'ok'; note: FormNote }
  /** The device already knew the set was unjudgeable; no model call happened. */
  | { kind: 'unusable'; reason: UnusableReason }
  /** Daily allowance spent. `pro` means upgrading lifts the cap. */
  | { kind: 'cap'; scope: 'free' | 'paid'; retryAfterSeconds?: number }
  /**
   * The account cannot use Drona at all (expired or cancelled), which is a
   * different conversation from having spent today's allowance.
   */
  | { kind: 'no_access' }
  | { kind: 'error'; message: string };

export interface RequestNoteArgs {
  client: SupabaseClient;
  summary: FormSummary;
  exerciseId: string | null;
}

export async function requestFormNote({
  client,
  summary,
  exerciseId,
}: RequestNoteArgs): Promise<FormNoteResult> {
  // Nothing to write about, so do not spend a call or a slot on it.
  if (summary.unusableReason) {
    return { kind: 'unusable', reason: summary.unusableReason };
  }

  const res = await client.functions.invoke('form-check', {
    // Pinned to the region the database and Anthropic both sit in. Measured
    // several seconds of difference on the coach calls.
    region: FunctionRegion.UsEast1,
    body: { mode: 'analyze', summary, exercise_id: exerciseId },
  });

  if (res.error) {
    const capped = await readCapError(res.error);
    if (capped) return capped;
    return { kind: 'error', message: await coachInvokeErrorMessage(res.error) };
  }

  const data = res.data as Record<string, unknown> | null;
  if (data?.unusable) {
    return { kind: 'unusable', reason: data.unusable as UnusableReason };
  }
  if (!data || typeof data.note !== 'string') {
    return { kind: 'error', message: 'I could not write that one up. Try again in a moment.' };
  }

  return {
    kind: 'ok',
    note: {
      id: typeof data.id === 'string' ? data.id : null,
      createdAt: typeof data.created_at === 'string' ? data.created_at : null,
      note: data.note,
      headline: typeof data.headline === 'string' ? data.headline : null,
      focus: typeof data.focus === 'string' ? data.focus : null,
      // The score is computed on the device; the server only echoes it back.
      // A non-numeric echo must not turn into a NaN rendered at the user.
      score: Number.isFinite(Number(data.score)) ? Number(data.score) : summary.score,
    },
  };
}

/**
 * Thrown when authoring is refused because the allowance is spent.
 *
 * Authoring is metered like analysis, but the ladder treats any failure as
 * "no rules for this lift". Without a distinct type a capped user is told the
 * exercise cannot be checked at all, which is both wrong and unrecoverable
 * sounding -- their rules are one day away, not impossible.
 */
export class FormCapError extends Error {
  constructor(readonly result: FormNoteResult) {
    super('form check allowance spent');
    this.name = 'FormCapError';
  }
}

/** Narrow an unknown caught value to a cap refusal. */
export function isCapError(e: unknown): e is FormCapError {
  return e instanceof FormCapError;
}

/**
 * Ask Drona to author rules for an unknown movement. Returns the RAW payload:
 * validation is the caller's job, through the single canonical validator in
 * ./spec.ts, so a malformed spec can never reach the engine.
 */
export async function requestAuthoredRules(
  client: SupabaseClient,
  exerciseName: string
): Promise<unknown> {
  const res = await client.functions.invoke('form-check', {
    region: FunctionRegion.UsEast1,
    body: { mode: 'author_rules', exercise_name: exerciseName },
  });
  if (res.error) {
    const capped = await readCapError(res.error);
    if (capped) throw new FormCapError(capped);
    throw res.error;
  }
  return res.data;
}

/**
 * A spent allowance is a product moment (the upgrade sheet), not an error
 * toast, so it has to be told apart from a genuine failure. FunctionsHttpError
 * hides the status and body on `error.context`.
 */
async function readCapError(error: unknown): Promise<FormNoteResult | null> {
  const context = (error as { context?: Response }).context;
  if (!context || typeof context.status !== 'number') return null;

  if (context.status !== 402 && context.status !== 429) return null;
  try {
    const body = (await context.clone().json()) as Record<string, unknown>;
    if (body.error === 'free_cap_hit') return { kind: 'cap', scope: 'free' };
    if (context.status === 429) {
      return {
        kind: 'cap',
        scope: 'paid',
        retryAfterSeconds: Number(body.retry_after_seconds ?? 0) || undefined,
      };
    }
    // Not a cap: the allowance is untouched, the account simply has no Drona
    // access. Telling this user to "come back tomorrow" would be a lie.
    if (body.error === 'drona_access_required') return { kind: 'no_access' };
  } catch {
    // Body already consumed or not JSON. Fall through to the generic path.
  }
  return null;
}
