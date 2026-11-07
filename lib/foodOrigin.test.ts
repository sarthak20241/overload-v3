// Step 4 in the app: what a saved card line writes to meal_entries.origin, and
// when an edit-sheet change means the user typed new numbers.
import { assertEquals } from 'jsr:@std/assert@1';
import { originColumns } from './foodOrigin';
import { numbersTyped } from './loggedEntryEdit';
import { entryTrust } from './yourFoods';

Deno.test('originColumns: the server origin wins; a copy keeps its own; old manual is unknown', () => {
  assertEquals(originColumns({ origin: 'label', source: 'web' }).origin, 'label');
  assertEquals(originColumns({ source: 'manual' }).origin, 'unknown');
  // A re-logged line keeps where its numbers came from.
  const relog = originColumns({ source: 'manual', relog: { origin: 'guess', source: 'estimate' } });
  assertEquals([relog.origin, relog.copied_from], ['guess', 'diary']);
  // An old re-log without an origin reads its source.
  assertEquals(originColumns({ source: 'estimate', relog: { source: 'estimate' } }).origin, 'guess');
  // Typed in the card editor.
  assertEquals(originColumns({ origin: 'user_typed', source: 'manual' }).origin, 'user_typed');
  // Typed over a re-logged line: the user's own, not a diary copy.
  const typedRelog = originColumns({ origin: 'user_typed', source: 'manual', relog: { origin: 'guess', source: 'estimate' } });
  assertEquals([typedRelog.origin, typedRelog.copied_from], ['user_typed', null]);
});

Deno.test('numbersTyped: an amount change keeps the numbers; new numbers per 100 g are typed', () => {
  const entry = { grams_logged: 100, kcal: 150, protein_g: 10, carb_g: 5, fat_g: 10 };
  assertEquals(numbersTyped(entry, { grams: 200, kcal: 300, protein_g: 20, carb_g: 10, fat_g: 20 }), false);
  assertEquals(numbersTyped(entry, { grams: 100, kcal: 170, protein_g: 10, carb_g: 5, fat_g: 10 }), true);
  assertEquals(numbersTyped(entry, { grams: 100, kcal: 150, protein_g: 12, carb_g: 5, fat_g: 10 }), true);
});

Deno.test('numbersTyped and the database trigger use the same thresholds', () => {
  // stamp_entry_origin (migration 20261107120000) holds the same rule in SQL:
  // kcal per 100 g by more than max(0.5, 1%), a macro by more than 0.2 g.
  const sql = Deno.readTextFileSync(new URL('../supabase/migrations/20261107120000_food_memory_sources.sql', import.meta.url));
  const body = sql.slice(sql.indexOf('function food_memory_private.stamp_entry_origin'), sql.indexOf('drop trigger if exists trg_meal_entries_stamp_origin'));
  assertEquals(body.includes('greatest(0.5, per_old * 0.01)'), true);
  assertEquals((body.match(/> 0\.2/g) ?? []).length, 3);
  const entry = { grams_logged: 100, kcal: 100, protein_g: 10, carb_g: 10, fat_g: 1 };
  assertEquals(numbersTyped(entry, { grams: 100, kcal: 100.9, protein_g: 10, carb_g: 10, fat_g: 1 }), false);
  assertEquals(numbersTyped(entry, { grams: 100, kcal: 101.1, protein_g: 10, carb_g: 10, fat_g: 1 }), true);
  assertEquals(numbersTyped(entry, { grams: 100, kcal: 100, protein_g: 10.3, carb_g: 10, fat_g: 1 }), true);
});

Deno.test('numbersTyped with no weight: any change of the numbers is typed', () => {
  const entry = { grams_logged: null, kcal: 300, protein_g: 10, carb_g: 40, fat_g: 10 };
  assertEquals(numbersTyped(entry, { grams: 0, kcal: 300, protein_g: 10, carb_g: 40, fat_g: 10 }), false);
  assertEquals(numbersTyped(entry, { grams: 0, kcal: 320, protein_g: 10, carb_g: 40, fat_g: 10 }), true);
});

Deno.test("Your foods: a proven origin ranks by it; 'unknown' keeps today's rank", () => {
  const base = { logged_via: 'ai', source: 'manual', tier: 'precise' };
  assertEquals(entryTrust({ ...base, origin: 'guess' }), 1);
  assertEquals(entryTrust({ ...base, origin: 'user_typed' }), 4);
  // Unproven old "manual": unchanged until the server switch moves.
  assertEquals(entryTrust({ ...base, origin: 'unknown' }), 4);
  assertEquals(entryTrust({ ...base, origin: null }), 4);
});
