// deno test --allow-all lib/paywallPlans.test.ts
import { assertEquals } from 'jsr:@std/assert';
import {
  accessHasPlan,
  connectFirstPaywallParams,
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

Deno.test('a purchase waits for the plan it bought; Restore takes either', () => {
  const proOnly = { state: 'paid', connect: false };
  const connectOnly = { state: 'free', connect: true };
  const both = { state: 'paid', connect: true };
  // A Pro subscriber buying Connect is not done until Connect is on.
  assertEquals(accessHasPlan(proOnly, 'connect'), false);
  assertEquals(accessHasPlan(both, 'connect'), true);
  // A Connect buyer adding Pro is not done until Pro is on.
  assertEquals(accessHasPlan(connectOnly, 'pro'), false);
  assertEquals(accessHasPlan({ state: 'trialing' }, 'pro'), true);
  assertEquals(accessHasPlan(connectOnly, 'either'), true);
  // The lock-out case: a free account with Connect has bought something.
  assertEquals(accessHasPlan({ state: 'free', connect: true }, 'connect'), true);
  assertEquals(accessHasPlan(proOnly, 'either'), true);
  assertEquals(accessHasPlan({ state: 'free' }, 'either'), false);
  assertEquals(accessHasPlan(null, 'either'), false);
});

Deno.test('the own-AI sign-up path opens the paywall on the Your own AI side', () => {
  const p = connectFirstPaywallParams({ connectFirst: true, isSignedIn: true, os: 'ios' });
  assertEquals(p, { flow: 'locked', context: 'connect' });
  // The context it sends is the one that opens the Your own AI side.
  assertEquals(initialSide(p!.context), 'own_ai');
  assertEquals(connectFirstPaywallParams({ connectFirst: true, isSignedIn: true, os: 'android' }) !== null, true);
  // The coach path, a guest and the web never get it.
  assertEquals(connectFirstPaywallParams({ connectFirst: false, isSignedIn: true, os: 'ios' }), null);
  assertEquals(connectFirstPaywallParams({ connectFirst: true, isSignedIn: false, os: 'ios' }), null);
  assertEquals(connectFirstPaywallParams({ connectFirst: true, isSignedIn: true, os: 'web' }), null);
});
