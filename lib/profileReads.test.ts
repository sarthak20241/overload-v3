// deno test --allow-all --unstable-sloppy-imports lib/profileReads.test.ts
//
// The profile row, goal history and one-day goals: one read each for every
// caller inside the window, and a write sends the next caller to the server.
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { resetForTest, setClockForTest } from './screenCache.ts';
import {
  invalidateProfile, loadDayGoals, loadProfileRow, loadTargetHistory, PROFILE_FRESH_MS,
} from './profileReads.ts';

/** A fake client: counts reads per table and answers with `rows[table]`. */
function fakeClient(rows: Record<string, unknown>, fail: Set<string> = new Set()) {
  const reads: Record<string, number> = {};
  const client = {
    from(table: string) {
      reads[table] = (reads[table] ?? 0) + 1;
      const answer = () => Promise.resolve(
        fail.has(table) ? { data: null, error: { message: 'boom' } } : { data: rows[table] ?? null, error: null },
      );
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain, eq: () => chain, gte: () => chain, order: () => chain,
        maybeSingle: answer,
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => answer().then(ok, bad),
      };
      return chain;
    },
  };
  return { client, reads };
}

const ROW = { clerk_user_id: 'u1', xp: 120, daily_calorie_target: 2100, calorie_day_boosts: [{ dow: 6, kcal: 300 }] };

Deno.test('every caller inside the window shares one profile read', async () => {
  resetForTest();
  const { client, reads } = fakeClient({ user_profiles: ROW });
  // The dashboard XP, the fuel targets, readiness and the analytics person
  // properties, as they ask at app start.
  const answers = await Promise.all([1, 2, 3, 4].map(() => loadProfileRow(client, 'u1')));
  answers.push(await loadProfileRow(client, 'u1'));
  assertEquals(reads.user_profiles, 1);
  for (const a of answers) assertEquals(a, ROW);
});

Deno.test('a write sends the next caller to the server, the goal history and day goals with it', async () => {
  resetForTest();
  const { client, reads } = fakeClient({ user_profiles: ROW, user_target_history: [], user_day_targets: [] });
  await loadProfileRow(client, 'u1');
  await loadTargetHistory(client, 'u1');
  await loadDayGoals(client, 'u1', '2026-11-10');
  invalidateProfile('u1');
  await loadProfileRow(client, 'u1');
  await loadTargetHistory(client, 'u1');
  await loadDayGoals(client, 'u1', '2026-11-10');
  assertEquals([reads.user_profiles, reads.user_target_history, reads.user_day_targets], [2, 2, 2]);
});

Deno.test('a write with no id (a card move) clears every user', async () => {
  resetForTest();
  const { client, reads } = fakeClient({ user_profiles: ROW });
  await loadProfileRow(client, 'u1');
  invalidateProfile();
  await loadProfileRow(client, 'u1');
  assertEquals(reads.user_profiles, 2);
});

Deno.test('past the window, or asked for fresh, it reads again', async () => {
  resetForTest();
  let now = 1_000_000;
  setClockForTest(() => now);
  const { client, reads } = fakeClient({ user_profiles: ROW });
  await loadProfileRow(client, 'u1');
  now += PROFILE_FRESH_MS + 1;
  await loadProfileRow(client, 'u1');
  await loadProfileRow(client, 'u1', { fresh: true });
  assertEquals(reads.user_profiles, 3);
});

Deno.test('a failed read is never kept: the next caller reads again', async () => {
  resetForTest();
  const fail = new Set(['user_target_history']);
  const { client, reads } = fakeClient({ user_target_history: [] }, fail);
  await assertRejects(() => loadTargetHistory(client, 'u1'));
  fail.clear();
  assertEquals(await loadTargetHistory(client, 'u1'), []);
  assertEquals(reads.user_target_history, 2);
});

Deno.test('the goal history and day goals are each read once for all their callers', async () => {
  resetForTest();
  const { client, reads } = fakeClient({ user_target_history: [], user_day_targets: [] });
  await Promise.all([loadTargetHistory(client, 'u1'), loadTargetHistory(client, 'u1'), loadTargetHistory(client, 'u1')]);
  await Promise.all([loadDayGoals(client, 'u1', '2026-11-10'), loadDayGoals(client, 'u1', '2026-11-10')]);
  assertEquals([reads.user_target_history, reads.user_day_targets], [1, 1]);
});
