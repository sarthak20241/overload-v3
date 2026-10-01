// Run with: deno test --no-check lib/loggedEntryEdit.test.ts
import { assertEquals, assert } from 'jsr:@std/assert@1';
import { persistLoggedEntryEdit } from './loggedEntryEdit.ts';

const entry = {
  id: 'entry', meal_id: 'old-meal', meal_type: 'breakfast', food_name: 'Test food',
  quantity: 1, serving_unit: 'glass', grams_logged: 240,
  kcal: 220, protein_g: 6, carb_g: 28, fat_g: 8,
};
const item = {
  food_id: null, food_name: entry.food_name, quantity: 1, serving_label: 'glass',
  grams: 240, kcal: 300, protein_g: 6.7, carb_g: 28, fat_g: 8,
  fiber_g: null, source: 'manual', assumption: null, confidence: 'high', meal_type: 'lunch',
};
const date = new Date(2026, 8, 27);
function fixture({ error = null, data = { id: 'entry' }, count = 0, countError = null } = {}) {
  const calls: unknown[] = [];
  const client = { from(table: string) {
    const q = {
      update(patch: unknown) { calls.push(['update', table, patch]); return q; },
      eq(key: string, value: unknown) { calls.push(['eq', key, value]); return q; },
      select(...args: unknown[]) { calls.push(['select', ...args]); return q; },
      single() { return Promise.resolve({ data, error }); },
      delete() { calls.push(['delete', table]); return q; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ count, error: countError }).then(resolve); },
    }; return q;
  } };
  const findMeal = async (meal: string, day: Date) => { calls.push(['findMeal', meal, day]); return { id: 'new-meal' }; };
  return { client, calls, findMeal };
}

Deno.test('saves decimal macros and a meal move together on the selected past date', async () => {
  const f = fixture();
  assertEquals(await persistLoggedEntryEdit(f.client, entry, item, date, f.findMeal), {});
  assertEquals(f.calls[0], ['findMeal', 'lunch', date]);
  const update = f.calls.find(c => c[0] === 'update');
  assertEquals(update[2], {
    meal_id: 'new-meal', quantity: 1, serving_unit: 'glass', grams_logged: 240,
    kcal: 300, protein_g: 6.7, carb_g: 28, fat_g: 8,
    source: 'manual', fiber_g: null, sugar_g: null, sat_fat_g: null, sodium_mg: null,
  });
  assertEquals(f.calls.filter(c => c[0] === 'update').length, 1);
  assert(f.calls.some(c => c[0] === 'delete' && c[1] === 'meals'));
});

Deno.test('a failed update keeps the source meal and reports an error', async () => {
  const f = fixture({ error: { message: 'Offline' }, data: null });
  assertEquals(await persistLoggedEntryEdit(f.client, entry, item, date, f.findMeal), { error: 'Offline' });
  assert(!f.calls.some(c => c[0] === 'delete'));
});

Deno.test('a zero-row update is not reported as saved', async () => {
  const f = fixture({ data: null });
  assert((await persistLoggedEntryEdit(f.client, entry, item, date, f.findMeal)).error);
  assert(!f.calls.some(c => c[0] === 'delete'));
});

Deno.test('unknown grams stay null and unchanged nutrition keeps extended snapshots', async () => {
  const f = fixture();
  const original = { ...entry, grams_logged: null };
  const unchanged = { ...item, ...entry, serving_label: 'glass', grams: 0 };
  assertEquals(await persistLoggedEntryEdit(f.client, original, unchanged, date, f.findMeal), {});
  const patch = f.calls.find(c => c[0] === 'update')[2];
  assertEquals(patch.grams_logged, null);
  assert(!('fiber_g' in patch));
  assert(!f.calls.some(c => c[0] === 'findMeal'));
});

Deno.test('invalid values are rejected before any database mutation', async () => {
  for (const patch of [{ quantity: 0 }, { quantity: Infinity }, { protein_g: -1 }, { kcal: NaN }, { serving_label: ' ' }]) {
    const f = fixture();
    assert((await persistLoggedEntryEdit(f.client, entry, { ...item, ...patch }, date, f.findMeal)).error);
    assertEquals(f.calls, []);
  }
});

Deno.test('a failed meal lookup never writes nutrition or moves the entry', async () => {
  const f = fixture();
  assertEquals(await persistLoggedEntryEdit(f.client, entry, item, date, async () => ({ error: 'No meal' })), { error: 'No meal' });
  assertEquals(f.calls, []);
});

Deno.test('a failed count query never deletes the old meal', async () => {
  const f = fixture({ countError: { message: 'Network error' } });
  assertEquals(await persistLoggedEntryEdit(f.client, entry, item, date, f.findMeal), {});
  assert(!f.calls.some(c => c[0] === 'delete'));
});
