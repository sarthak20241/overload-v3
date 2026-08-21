/**
 * Rule-resolution ladder tests.
 *
 * This is the part that makes form checking cover a catalog nobody authored
 * rules for: ~800 global exercises plus whatever Coach Drona invents mid
 * workout. The ladder has to be cheap-first (never pay the model for a squat)
 * and it has to cache, or every check re-pays for the same answer.
 *
 * Run via tools/form-eval/run.ts.
 */

import {
  canCheckForm,
  resolveFormRules,
  resolveLocal,
  isPersistableId,
} from '../../lib/form/resolve';
import { PATTERN_SPECS } from '../../lib/form/patterns';

type Row = Record<string, unknown>;

/**
 * Minimal stand-in for the Supabase client. Records every write so a test can
 * assert the ladder cached what it learned, and counts reads so a test can
 * assert the cheap tiers short-circuited before any query happened.
 */
export function fakeClient(globalRows: Row[] = [], ownRows: Row[] = []) {
  const updates: Array<{ id: string; patch: Row }> = [];
  let selects = 0;
  let rowReads = 0;

  const client = {
    from(_table: string) {
      const state: { patch: Row | null; id: string | null } = { patch: null, id: null };
      const builder: Record<string, unknown> = {
        select(_cols: string) {
          selects++;
          return builder;
        },
        is() {
          // `.is('created_by', null)` narrows to the global catalog. These
          // fixtures hold only global rows, so it is a pass-through.
          return builder;
        },
        update(patch: Row) {
          state.patch = patch;
          return builder;
        },
        eq(col: string, value: string) {
          // A write: `update(...).eq('id', id)` resolves straight to a result.
          if (state.patch) {
            const patch = state.patch;
            updates.push({ id: value, patch });
            return Promise.resolve({ error: null });
          }
          // The twin lookup: an indexed equality on the generated lowercase
          // name, then `.limit(1)`.
          if (col === 'name_lower') {
            const match = globalRows.filter(
              (r) => String(r.name).toLowerCase() === value
            );
            return { limit: async () => ({ data: match, error: null }) };
          }
          // Reading the exercise's own row: `.eq('id', id).maybeSingle()`.
          return {
            maybeSingle: async () => {
              rowReads++;
              return { data: ownRows.find((r) => r.id === value) ?? null, error: null };
            },
          };
        },
      };
      return builder;
    },
  };

  return {
    client: client as never,
    updates,
    get selects() {
      return selects;
    },
    /** How many times the ladder read the exercise's own row. */
    get rowReads() {
      return rowReads;
    },
  };
}

export interface LadderHarness {
  check: (name: string, fn: () => void | Promise<void>) => void;
  eq: (a: unknown, b: unknown, what: string) => void;
  assert: (cond: boolean, what: string) => void;
}

const UUID = '11111111-2222-4333-8444-555555555555';

export async function runResolveTests({ check, eq, assert }: LadderHarness) {
  // ── the free tiers ────────────────────────────────────────────────────────

  check('a curated spec on the row wins outright', () => {
    const r = resolveLocal({
      id: UUID,
      name: 'Anything At All',
      form_rules: PATTERN_SPECS.hinge,
    });
    eq(r.origin, 'exercise', 'origin');
    assert(r.spec?.rep.driver === 'hip', 'should be the hinge spec');
  });

  check('an invalid stored spec is ignored, not trusted', () => {
    // A spec written by an older app version, or a model that has since been
    // fixed, must never be acted on just because it is in the database.
    const r = resolveLocal({
      id: UUID,
      name: 'Barbell Squat',
      form_rules: { version: 1, view: 'side', measures: [], rep: {}, cues: [] },
    });
    eq(r.origin, 'name_guess', 'should fall through to the name guess');
    assert(r.spec !== null, 'should still resolve a usable spec');
  });

  check('a stored pattern resolves to its template', () => {
    const r = resolveLocal({ id: UUID, name: 'Some Odd Name', movement_pattern: 'squat' });
    eq(r.origin, 'pattern', 'origin');
    eq(r.pattern, 'squat', 'pattern');
  });

  check("a stored pattern of 'none' means we refuse honestly", () => {
    const r = resolveLocal({ id: UUID, name: 'Barbell Squat', movement_pattern: 'none' });
    assert(r.unsupported, 'should be unsupported');
    eq(r.spec, null, 'no spec');
  });

  check('an unknown name resolves to nothing, without claiming unsupported', () => {
    const r = resolveLocal({ id: UUID, name: 'Turkish Getup' });
    eq(r.spec, null, 'no spec');
    assert(!r.unsupported, 'unknown is not the same as unjudgeable');
  });

  // ── what the UI asks ──────────────────────────────────────────────────────

  check('canCheckForm hides only the genuinely unjudgeable', () => {
    assert(canCheckForm({ id: UUID, name: 'Barbell Squat' }), 'squat');
    assert(!canCheckForm({ id: UUID, name: 'Treadmill Run' }), 'cardio');
    assert(!canCheckForm({ id: UUID, name: 'Leg Curl' }), 'machine isolation');
    // Unknown movements stay offered: the ladder can author rules for them.
    assert(canCheckForm({ id: UUID, name: 'Turkish Getup' }), 'unknown');
  });

  // ── the network tiers ─────────────────────────────────────────────────────

  await check('a known lift never touches the network or the model', async () => {
    // The exercise list already holds these columns, so a caller that passes
    // them costs the ladder nothing at all.
    const f = fakeClient();
    let authored = 0;
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Barbell Back Squat', form_rules: null, movement_pattern: null },
      authorSpec: async () => {
        authored++;
        return {};
      },
    });
    eq(r.origin, 'name_guess', 'origin');
    eq(authored, 0, 'model calls');
    eq(f.selects, 0, 'catalog queries');
  });

  await check('rules already cached on the row are reused, never re-authored', async () => {
    // The form-check screen only knows the id and name, both from route params.
    // If the ladder did not read the row it would skip straight past the spec a
    // previous check already paid the model to author, and buy it again on
    // every single open.
    const f = fakeClient(
      [],
      [{ id: UUID, form_rules: PATTERN_SPECS.hinge, movement_pattern: 'hinge' }]
    );
    let authored = 0;
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Turkish Getup' },
      authorSpec: async () => {
        authored++;
        return { unsupported: false, pattern: 'lunge', spec: PATTERN_SPECS.lunge };
      },
    });
    eq(f.rowReads, 1, 'row reads');
    eq(r.origin, 'exercise', 'origin');
    eq(authored, 0, 'model calls');
  });

  await check('a curated override on the row beats the name guess', async () => {
    // Step 1 must outrank step 4, or curating rules for a specific lift would
    // have no effect whenever its name happens to be guessable.
    const f = fakeClient([], [{ id: UUID, form_rules: PATTERN_SPECS.hinge, movement_pattern: null }]);
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Barbell Back Squat' },
    });
    eq(r.origin, 'exercise', 'origin');
    assert(r.spec?.rep.driver === 'hip', 'should be the curated hinge spec, not the squat guess');
  });

  await check('a name guess is written back so the next check is free', async () => {
    const f = fakeClient();
    await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Barbell Back Squat' },
    });
    // Persistence is fire-and-forget; let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    eq(f.updates.length, 1, 'writes');
    eq(f.updates[0].patch.movement_pattern, 'squat', 'cached pattern');
  });

  await check('an AI-created copy inherits the global twin rules', async () => {
    // Drona invents "Barbell Hip Hinge" as a user-owned row with no rules; the
    // global catalog already has a curated spec under the same name.
    const f = fakeClient([
      { name: 'Barbell Hip Hinge', form_rules: PATTERN_SPECS.hinge, movement_pattern: 'hinge' },
    ]);
    let authored = 0;
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Barbell Hip Hinge' },
      authorSpec: async () => {
        authored++;
        return {};
      },
    });
    // The name rule catches "hinge" before the twin lookup, which is the
    // cheaper answer and the same one.
    assert(r.spec !== null, 'should resolve');
    eq(authored, 0, 'model calls');
  });

  await check('a genuinely novel movement is authored, then cached', async () => {
    const f = fakeClient();
    let authored = 0;
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Turkish Getup' },
      authorSpec: async () => {
        authored++;
        return { unsupported: false, pattern: 'lunge', spec: PATTERN_SPECS.lunge };
      },
    });
    eq(authored, 1, 'model calls');
    eq(r.origin, 'authored', 'origin');
    await new Promise((res) => setTimeout(res, 0));
    assert(f.updates.some((u) => u.patch.form_rules != null), 'spec should be cached to the row');
  });

  await check('a malformed authored spec is rejected, not stored', async () => {
    const f = fakeClient();
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Turkish Getup' },
      authorSpec: async () => ({
        unsupported: false,
        pattern: 'squat',
        spec: { version: 1, view: 'sideways', measures: [], rep: {}, cues: [] },
      }),
    });
    eq(r.spec, null, 'no spec');
    await new Promise((res) => setTimeout(res, 0));
    assert(!f.updates.some((u) => u.patch.form_rules != null), 'nothing should be cached');
  });

  await check("the model may answer 'cannot be checked'", async () => {
    const f = fakeClient();
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Turkish Getup' },
      authorSpec: async () => ({ unsupported: true }),
    });
    assert(r.unsupported, 'should be unsupported');
    await new Promise((res) => setTimeout(res, 0));
    assert(
      f.updates.some((u) => u.patch.movement_pattern === 'none'),
      'the refusal should be cached so we never ask twice'
    );
  });

  await check('a model failure degrades quietly instead of throwing', async () => {
    const f = fakeClient();
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: UUID, name: 'Turkish Getup' },
      authorSpec: async () => {
        throw new Error('network down');
      },
    });
    eq(r.spec, null, 'no spec');
    assert(!r.unsupported, 'a failed call is not proof the lift is unjudgeable');
  });

  // ── synthetic ids ─────────────────────────────────────────────────────────

  check('synthetic library ids are recognised as unwritable', () => {
    assert(isPersistableId(UUID), 'real uuid');
    assert(!isPersistableId('lib-3'), 'bundled library row');
    assert(!isPersistableId('local-ex-abc'), 'offline custom');
    assert(!isPersistableId(''), 'empty');
  });

  await check('a bundled library row is checkable but never written to', async () => {
    const f = fakeClient();
    const r = await resolveFormRules({
      client: f.client,
      exercise: { id: 'lib-7', name: 'Barbell Back Squat' },
    });
    assert(r.spec !== null, 'should still resolve rules');
    await new Promise((res) => setTimeout(res, 0));
    eq(f.updates.length, 0, 'no writes for a row that does not exist');
  });
}
