// Step 4 in the app: what a saved card line writes to meal_entries.origin, and
// when an edit-sheet change means the user typed new numbers.
import { assertEquals } from 'jsr:@std/assert@1';
import { originColumns } from './foodOrigin';
import { numbersTyped } from './loggedEntryEdit';

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
