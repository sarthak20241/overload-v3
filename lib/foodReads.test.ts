// deno test --allow-all lib/foodReads.test.ts
//
// Three food reads went from two trips (the meals, then their entries by id)
// to one embedded select. These tests pin that the embedded rows reshape to
// what the two-trip version produced.
import { assertEquals } from 'jsr:@std/assert@1';
import { dayTotalsFromMeals, entriesNewestFirst, itemsInPositionOrder } from './foodReads.ts';

const e = (kcal: number, p = 0, c = 0, f = 0) => ({ kcal, protein_g: p, carb_g: c, fat_g: f });
const dayOf = (loggedAt: string) => loggedAt.slice(0, 10);

Deno.test('day totals: entries add up on the day their meal was logged, zeros for empty days', () => {
  const meals = [
    { logged_at: '2026-10-20T08:00:00', meal_entries: [e(300, 20, 30, 10), e(100, 5, 10, 2)] },
    { logged_at: '2026-10-20T13:00:00', meal_entries: [e(500, 40, 50, 15)] },
    { logged_at: '2026-10-22T19:00:00', meal_entries: [e('250' as unknown as number, null as unknown as number)] },
    // A meal with no entries left (all deleted) adds nothing.
    { logged_at: '2026-10-21T09:00:00', meal_entries: [] },
  ];
  assertEquals(dayTotalsFromMeals(['2026-10-20', '2026-10-21', '2026-10-22'], meals, dayOf), [
    { dayIso: '2026-10-20', kcal: 900, protein_g: 65, carb_g: 90, fat_g: 27 },
    { dayIso: '2026-10-21', kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
    { dayIso: '2026-10-22', kcal: 250, protein_g: 0, carb_g: 0, fat_g: 0 },
  ]);
});

Deno.test('day totals: a meal outside the days asked for is ignored', () => {
  const meals = [{ logged_at: '2026-10-19T23:00:00', meal_entries: [e(800)] }];
  assertEquals(dayTotalsFromMeals(['2026-10-20'], meals, dayOf), [
    { dayIso: '2026-10-20', kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
  ]);
});

Deno.test('recent foods: entries come newest meal first, as the sort by meal time gave them', () => {
  // The meals arrive newest first (the query orders them).
  const meals = [
    { logged_at: '2026-10-22T19:00:00', meal_entries: [{ food_name: 'Rice' }, { food_name: 'Dal' }] },
    { logged_at: '2026-10-22T08:00:00', meal_entries: [{ food_name: 'Eggs' }] },
    { logged_at: '2026-10-21T08:00:00', meal_entries: null },
    { logged_at: '2026-10-20T08:00:00', meal_entries: [{ food_name: 'Rice' }] },
  ];
  assertEquals(entriesNewestFirst(meals).map((x) => x.food_name), ['Rice', 'Dal', 'Eggs', 'Rice']);
});

Deno.test('saved meal items: in position order, as the ordered items read gave them', () => {
  const items = [{ food_name: 'b', position: 1 }, { food_name: 'c', position: 2 }, { food_name: 'a', position: 0 }];
  assertEquals(itemsInPositionOrder(items).map((x) => x.food_name), ['a', 'b', 'c']);
  assertEquals(itemsInPositionOrder(null), []);
});
