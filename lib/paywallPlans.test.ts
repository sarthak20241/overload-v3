// deno test --allow-all lib/paywallPlans.test.ts
import { assertEquals } from 'jsr:@std/assert';
import {
  ctaLabel,
  initialSide,
  layoutFromFlag,
  planFor,
  priceLine,
  SIDE_PERIODS,
  sideFeatures,
} from './paywallPlans.ts';

Deno.test('Drona sells only Pro plans, and no lifetime', () => {
  assertEquals(SIDE_PERIODS.drona, ['annual', 'monthly']);
  assertEquals(planFor('drona', 'annual'), 'annual');
  assertEquals(planFor('drona', 'monthly'), 'monthly');
  assertEquals(planFor('drona', 'lifetime'), null);
});

Deno.test('Your own AI sells only Connect plans', () => {
  for (const p of SIDE_PERIODS.own_ai) {
    assertEquals(String(planFor('own_ai', p)).startsWith('connect_'), true, p);
  }
});

Deno.test('a trial is promised only when the store gives one', () => {
  assertEquals(ctaLabel('drona', 'annual', 7), 'Try Drona free for 7 days');
  assertEquals(ctaLabel('drona', 'annual', 0), 'Continue');
  assertEquals(ctaLabel('own_ai', 'monthly', 7), 'Try free for 7 days');
  assertEquals(ctaLabel('own_ai', 'lifetime', 7), 'Buy once');
  assertEquals(priceLine('annual', '$49.99', 7), 'Then $49.99 a year. Cancel any time.');
  assertEquals(priceLine('monthly', '$2.99', 0), '$2.99 a month. Cancel any time.');
  assertEquals(priceLine('lifetime', '$49.99', 0), '$49.99 one time. Yours forever.');
});

Deno.test('six features per side; Drona has all, Connect locks the coach', () => {
  assertEquals(sideFeatures('drona').length, 6);
  assertEquals(sideFeatures('drona').every((f) => f.included), true);
  const own = sideFeatures('own_ai');
  assertEquals(own.length, 6);
  assertEquals(own.filter((f) => !f.included).map((f) => f.label), [
    'Coach in the app',
    'A plan that adapts to you',
    'Weekly insights',
  ]);
  // Included first, locked after.
  assertEquals(own.slice(0, 3).every((f) => f.included), true);
});

Deno.test('layout A unless the flag says list; opens on Drona unless asked', () => {
  assertEquals(layoutFromFlag('list'), 'list');
  assertEquals(layoutFromFlag('tiles'), 'tiles');
  assertEquals(layoutFromFlag(undefined), 'tiles');
  assertEquals(layoutFromFlag('control'), 'tiles');
  assertEquals(initialSide('connect'), 'own_ai');
  assertEquals(initialSide(null), 'drona');
  assertEquals(initialSide('cap_chat'), 'drona');
});
