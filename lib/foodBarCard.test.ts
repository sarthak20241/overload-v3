// Run with: deno test --allow-all lib/foodBarCard.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { cardAfter } from './foodBarCard.ts';

const LUNCH = ['jeera rice', 'paneer sabji', 'soya', 'methi aloo'];

Deno.test('a save card leaves the meal card on screen (live 2026-11-05 15:23)', () => {
  assertEquals(cardAfter(LUNCH, { kind: 'create' }), LUNCH);
});

Deno.test('a save card with no meal card on screen shows no meal card', () => {
  assertEquals(cardAfter(null, { kind: 'create' }), null);
});

Deno.test('a reply keeps the card; removing the last line clears it', () => {
  assertEquals(cardAfter(LUNCH, { kind: 'declined' }), LUNCH);
  assertEquals(cardAfter(LUNCH, { kind: 'declined', cleared: true }), null);
});

Deno.test('new food joins the card; a correction replaces it', () => {
  assertEquals(cardAfter(['samosa'], { kind: 'meal', items: ['dosa'], correctsPrevious: false }), ['samosa', 'dosa']);
  assertEquals(cardAfter(['samosa'], { kind: 'meal', items: ['small samosa'], correctsPrevious: true }), ['small samosa']);
  assertEquals(cardAfter(null, { kind: 'meal', items: ['dosa'], correctsPrevious: false }), ['dosa']);
});

Deno.test('an error leaves the card as it was', () => {
  assertEquals(cardAfter(LUNCH, { kind: 'other' }), LUNCH);
});
