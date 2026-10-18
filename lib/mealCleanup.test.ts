// Run with: deno test --allow-all lib/mealCleanup.test.ts
import { assertEquals, assert } from 'jsr:@std/assert@1';
import { deleteMealIfEmpty } from './mealCleanup.ts';

function fake({ rpcError = null as null | { code: string }, count = 0, countError = null as null | { message: string } } = {}) {
  const calls: unknown[][] = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push(['rpc', name, args]);
      return Promise.resolve({ data: rpcError ? null : true, error: rpcError });
    },
    from(table: string) {
      const q = {
        select(..._a: unknown[]) { calls.push(['select', table]); return q; },
        eq(k: string, v: unknown) { calls.push(['eq', table, k, v]); return q; },
        delete() { calls.push(['delete', table]); return q; },
        then(resolve: (v: unknown) => unknown) { return Promise.resolve({ count, error: countError }).then(resolve); },
      };
      return q;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { client: client as any, calls };
}

Deno.test('the database does it in one step: no client-side count or delete', async () => {
  const f = fake();
  await deleteMealIfEmpty(f.client, 'meal-1');
  assertEquals(f.calls, [['rpc', 'delete_meal_if_empty', { p_meal_id: 'meal-1' }]]);
});

Deno.test('before the migration is live, it falls back to count then delete', async () => {
  for (const code of ['PGRST202', '42883']) {
    const f = fake({ rpcError: { code } });
    await deleteMealIfEmpty(f.client, 'meal-1');
    assert(f.calls.some((c) => c[0] === 'select' && c[1] === 'meal_entries'), code);
    assert(f.calls.some((c) => c[0] === 'delete' && c[1] === 'meals'), code);
  }
});

Deno.test('the fallback keeps a meal that still has food', async () => {
  const f = fake({ rpcError: { code: 'PGRST202' }, count: 2 });
  await deleteMealIfEmpty(f.client, 'meal-1');
  assert(!f.calls.some((c) => c[0] === 'delete'));
});

Deno.test('a failed count is not "empty"', async () => {
  const f = fake({ rpcError: { code: 'PGRST202' }, countError: { message: 'Network error' } });
  await deleteMealIfEmpty(f.client, 'meal-1');
  assert(!f.calls.some((c) => c[0] === 'delete'));
});

Deno.test('a real RPC error never falls back to the unsafe path', async () => {
  const f = fake({ rpcError: { code: '40001' } });
  await deleteMealIfEmpty(f.client, 'meal-1');
  assertEquals(f.calls.length, 1);
});
