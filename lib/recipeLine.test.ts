// Run with: deno test --allow-all lib/recipeLine.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { sourceBeforeOrigin } from './recipeLine.ts';

Deno.test('sourceBeforeOrigin: a recipe line is written as an estimate on a database without the origin columns', () => {
  const rows = [{ food_name: 'Paneer sabji', source: 'recipe' }, { food_name: 'Rice', source: 'catalog' }];
  assertEquals(sourceBeforeOrigin(rows).map((r) => r.source), ['estimate', 'catalog']);
  // The input is not changed.
  assertEquals(rows[0].source, 'recipe');
});
