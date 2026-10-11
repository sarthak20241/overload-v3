// Run with: deno test --allow-all lib/variantSwap.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { optionAt, readSwapOptions, swapLabel, swapToAlternative, type SwapLine } from './variantSwap.ts';

const vanilla = {
  food_name: 'vanilla whey', grams: 30, kcal: 114, protein_g: 23, carb_g: 3, fat_g: 1.5, fiber_g: null,
  source: 'catalog' as const, assumption: 'Same as you logged on Sep 22',
};
const chocolate: SwapLine & { quantity: number; serving_label: string; meal_type: string } = {
  food_id: null, food_name: 'chocolate whey', quantity: 30, serving_label: 'g', meal_type: 'snack',
  grams: 30, kcal: 117, protein_g: 24, carb_g: 3, fat_g: 1.5, fiber_g: null,
  source: 'estimate', assumption: 'Same as you logged on Sep 26', confidence: 'high', alternatives: [vanilla],
};

Deno.test('one tap swaps the line to the variant, keeping its amount, unit and section', () => {
  const s = swapToAlternative(chocolate, 0);
  assertEquals([s.food_name, s.kcal, s.protein_g, s.source, s.assumption], ['vanilla whey', 114, 23, 'catalog', 'Same as you logged on Sep 22']);
  assertEquals([s.quantity, s.serving_label, s.meal_type, s.grams], [30, 'g', 'snack', 30]);
});

Deno.test('a wrong tap is undone with one more tap', () => {
  const back = swapToAlternative(swapToAlternative(chocolate, 0), 0);
  assertEquals([back.food_name, back.kcal, back.assumption], ['chocolate whey', 117, 'Same as you logged on Sep 26']);
  assertEquals(back.alternatives?.map((a) => a.food_name), ['vanilla whey']);
});

Deno.test('the failure this prevents: an amount edited before the tap kept the old weight\'s numbers', () => {
  // The user changed 30 g to 45 g, then tapped vanilla: 45 g of vanilla, not 30.
  const s = swapToAlternative({ ...chocolate, grams: 45, kcal: 175.5 }, 0);
  assertEquals([s.grams, s.kcal, s.protein_g], [45, 171, 34.5]);
  assertEquals(optionAt(vanilla, 0).kcal, 114);
});

Deno.test('malformed options are dropped, and none at all means no chip', () => {
  assertEquals(readSwapOptions(undefined), undefined);
  assertEquals(readSwapOptions([{ food_name: '', grams: 30 }, { food_name: 'x', grams: 0 }, null]), undefined);
  const [o] = readSwapOptions([{ ...vanilla, source: 'made-up', kcal: 'NaN' }])!;
  assertEquals([o.source, o.kcal], ['estimate', 0]);
  assertEquals(readSwapOptions([vanilla, vanilla, vanilla])!.length, 2);
  assertEquals(swapToAlternative(chocolate, 5), chocolate);
});

Deno.test('only the variant the user logs most is labelled their usual', () => {
  assertEquals(chocolate.usual, undefined); // as served: the usual one
  const swapped = swapToAlternative(chocolate, 0);
  assertEquals(swapped.usual, false);
  assertEquals(swapped.alternatives?.[0].usual, true);
  assertEquals(swapToAlternative(swapped, 0).usual, true);
});

Deno.test('the failure this prevents: an edited line still called itself the user\'s usual', () => {
  assertEquals(swapLabel(chocolate), 'your usual');
  assertEquals(swapLabel(swapToAlternative(chocolate, 0)), 'your log');
  // The editor clears the note and marks the line manual: it is "edited" now.
  assertEquals(swapLabel({ ...chocolate, source: 'manual', assumption: null } as SwapLine), null);
});
