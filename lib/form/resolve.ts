/**
 * How an exercise gets its form rules.
 *
 * The catalog is roughly 800 global rows plus a long tail of per-user
 * exercises that Coach Drona invents mid-workout, and neither set was authored
 * with form checking in mind. Rather than hand-writing 800 rule files, rules
 * are resolved through a ladder that gets cheaper-first and only reaches the
 * model for genuinely novel movements. Whatever the ladder produces is written
 * back to the row, so every exercise is paid for at most once, ever.
 *
 * Ladder:
 *   1. `exercises.form_rules`            curated, or authored on a past check
 *   2. same-named GLOBAL row's rules      catches AI copies of catalog lifts
 *   3. `exercises.movement_pattern`       the pattern template
 *   4. name guess -> pattern template     free, covers most of the catalog
 *   5. ask Drona to author a spec         validated, then cached to the row
 *   6. give up honestly                   "I cannot check this one yet"
 *
 * Steps 1 to 4 are local or a single indexed query. Only step 5 costs money.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { guessPattern, isMovementPattern, specForPattern, type MovementPattern } from './patterns';
import { parseFormRuleSpec, type FormRuleSpec } from './spec';

/** The exercise fields this module needs. A subset of the `exercises` row. */
export interface FormCheckableExercise {
  id: string;
  name: string;
  movement_pattern?: string | null;
  form_rules?: unknown;
}

export type RuleOrigin =
  | 'exercise'
  | 'global_twin'
  | 'pattern'
  | 'name_guess'
  | 'authored'
  | 'none';

export interface RuleResolution {
  spec: FormRuleSpec | null;
  pattern: MovementPattern | null;
  origin: RuleOrigin;
  /** True when the exercise is known to be unjudgeable from a phone camera. */
  unsupported: boolean;
}

const NOT_CHECKABLE: RuleResolution = {
  spec: null,
  pattern: 'none',
  origin: 'none',
  unsupported: true,
};

/**
 * Resolve rules WITHOUT any network call. Used to decide whether to even show
 * the "Check my form" entry point, and as the fast path once a row is tagged.
 */
export function resolveLocal(exercise: FormCheckableExercise): RuleResolution {
  // 1. Rules stored on the row. Validated every time: a spec written by an
  //    older app version or a since-fixed model must not be trusted blindly.
  if (exercise.form_rules) {
    const parsed = parseFormRuleSpec(exercise.form_rules);
    if (parsed.ok) {
      return {
        spec: parsed.spec,
        pattern: normalisePattern(exercise.movement_pattern),
        origin: 'exercise',
        unsupported: false,
      };
    }
    console.warn(
      `[form] ignoring invalid form_rules on "${exercise.name}": ${parsed.errors.join('; ')}`
    );
  }

  // 3. The stored movement pattern.
  const stored = normalisePattern(exercise.movement_pattern);
  if (stored === 'none') return NOT_CHECKABLE;
  if (stored) {
    const spec = specForPattern(stored);
    if (spec) return { spec, pattern: stored, origin: 'pattern', unsupported: false };
  }

  // 4. Guess from the name. Free, and right for most of the catalog.
  const guessed = guessPattern(exercise.name);
  if (guessed === 'none') return NOT_CHECKABLE;
  if (guessed) {
    const spec = specForPattern(guessed);
    if (spec) return { spec, pattern: guessed, origin: 'name_guess', unsupported: false };
  }

  return { spec: null, pattern: null, origin: 'none', unsupported: false };
}

export interface ResolveOptions {
  client: SupabaseClient;
  exercise: FormCheckableExercise;
  /**
   * Called when the ladder runs out of free options. Should hit the form-check
   * edge function in `author_rules` mode and return the raw spec. Omit to stop
   * at step 4, which is what the picker does when it is only deciding whether
   * to show a button.
   */
  authorSpec?: (name: string) => Promise<unknown>;
}

/**
 * Full ladder, including the network steps. Persists whatever it learns.
 */
export async function resolveFormRules({
  client,
  exercise,
  authorSpec,
}: ResolveOptions): Promise<RuleResolution> {
  const local = resolveLocal(exercise);
  if (local.spec || local.unsupported) {
    // A name guess is worth writing back so the next check skips the guessing
    // and so the coach can see the pattern. Best effort: never block on it.
    if (local.origin === 'name_guess' && local.pattern) {
      void persistPattern(client, exercise.id, local.pattern);
    }
    return local;
  }

  // 2. A global row with the same name. AI-created exercises are usually
  //    duplicates of catalog lifts ("Barbell Squat" typed slightly
  //    differently), so this inherits curated rules for free.
  const twin = await findGlobalTwin(client, exercise.name);
  if (twin) {
    const parsed = twin.form_rules ? parseFormRuleSpec(twin.form_rules) : null;
    if (parsed?.ok) {
      void persistRules(client, exercise.id, twin.form_rules, normalisePattern(twin.movement_pattern));
      return {
        spec: parsed.spec,
        pattern: normalisePattern(twin.movement_pattern),
        origin: 'global_twin',
        unsupported: false,
      };
    }
    const twinPattern = normalisePattern(twin.movement_pattern);
    if (twinPattern === 'none') {
      void persistPattern(client, exercise.id, 'none');
      return NOT_CHECKABLE;
    }
    const spec = specForPattern(twinPattern);
    if (spec && twinPattern) {
      void persistPattern(client, exercise.id, twinPattern);
      return { spec, pattern: twinPattern, origin: 'global_twin', unsupported: false };
    }
  }

  // 5. Ask Drona. Only reached for movements the catalog has never seen.
  if (!authorSpec) return { spec: null, pattern: null, origin: 'none', unsupported: false };

  let raw: unknown;
  try {
    raw = await authorSpec(exercise.name);
  } catch (e) {
    console.warn(`[form] rule authoring failed for "${exercise.name}"`, e);
    return { spec: null, pattern: null, origin: 'none', unsupported: false };
  }

  // The model may legitimately answer "this cannot be checked".
  const authored = raw as { unsupported?: boolean; pattern?: unknown; spec?: unknown } | null;
  if (authored?.unsupported) {
    void persistPattern(client, exercise.id, 'none');
    return NOT_CHECKABLE;
  }

  const parsed = parseFormRuleSpec(authored?.spec);
  if (!parsed.ok) {
    console.warn(`[form] authored spec rejected for "${exercise.name}": ${parsed.errors.join('; ')}`);
    return { spec: null, pattern: null, origin: 'none', unsupported: false };
  }

  const pattern = normalisePattern(authored?.pattern);
  void persistRules(client, exercise.id, parsed.spec, pattern);
  return { spec: parsed.spec, pattern, origin: 'authored', unsupported: false };
}

/** Cheap yes/no for the UI, no network. */
export function canCheckForm(exercise: FormCheckableExercise): boolean {
  const r = resolveLocal(exercise);
  // An unknown movement is still offered: the ladder can author rules for it.
  return !r.unsupported;
}

// ── persistence ─────────────────────────────────────────────────────────────
// All writes are best effort. RLS allows a user to update only their OWN rows,
// so writing back to a global exercise silently affects nothing, which is the
// correct outcome: the curated catalog is maintained by migration, not by
// whatever a client decided today.

/**
 * Is this a real `exercises.id`?
 *
 * The exercise library screen renders bundled rows with synthetic ids like
 * `lib-3` so the catalog works offline, and guest customs carry local ids.
 * Those are perfectly valid to CHECK the form of, but there is no row to write
 * back to, and handing a non-uuid to PostgREST produces a confusing cast error
 * rather than a no-op.
 */
export function isPersistableId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function persistPattern(
  client: SupabaseClient,
  exerciseId: string,
  pattern: MovementPattern
): Promise<void> {
  if (!isPersistableId(exerciseId)) return;
  const { error } = await client
    .from('exercises')
    .update({ movement_pattern: pattern })
    .eq('id', exerciseId);
  if (error) console.warn('[form] could not persist movement_pattern', error.message);
}

async function persistRules(
  client: SupabaseClient,
  exerciseId: string,
  rules: unknown,
  pattern: MovementPattern | null
): Promise<void> {
  if (!isPersistableId(exerciseId)) return;
  const patch: Record<string, unknown> = { form_rules: rules };
  if (pattern) patch.movement_pattern = pattern;
  const { error } = await client.from('exercises').update(patch).eq('id', exerciseId);
  if (error) console.warn('[form] could not persist form_rules', error.message);
}

async function findGlobalTwin(
  client: SupabaseClient,
  name: string
): Promise<{ form_rules: unknown; movement_pattern: string | null } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { data, error } = await client
    .from('exercises')
    .select('form_rules, movement_pattern')
    .is('created_by', null)
    .ilike('name', trimmed)
    .limit(1);
  if (error) {
    console.warn('[form] global twin lookup failed', error.message);
    return null;
  }
  const row = data?.[0];
  return row ? { form_rules: row.form_rules, movement_pattern: row.movement_pattern } : null;
}

function normalisePattern(v: unknown): MovementPattern | null {
  return isMovementPattern(v) ? v : null;
}
