import { assertEquals } from 'jsr:@std/assert';
import { HARD_PAYWALL_FROM, isHardPaywallAccount, mustPay } from './hardPaywall.ts';

const NEW = new Date(HARD_PAYWALL_FROM + 60_000);
const OLD = new Date(HARD_PAYWALL_FROM - 60_000);

Deno.test('a new free account must pay', () => {
  assertEquals(mustPay({ createdAt: NEW, accessState: 'free', purchasesAvailable: true }), true);
});

Deno.test('an account from before the cutoff keeps the free plan', () => {
  assertEquals(mustPay({ createdAt: OLD, accessState: 'free', purchasesAvailable: true }), false);
});

Deno.test('paid and trialing are never locked', () => {
  for (const s of ['paid', 'trialing']) {
    assertEquals(mustPay({ createdAt: NEW, accessState: s, purchasesAvailable: true }), false, s);
  }
});

Deno.test('unknown or signed-out access never locks (network blip)', () => {
  for (const s of ['unknown', 'unauthenticated']) {
    assertEquals(mustPay({ createdAt: NEW, accessState: s, purchasesAvailable: true }), false, s);
  }
});

Deno.test('legacy not-paying states lock a new account', () => {
  for (const s of ['trial_ended', 'eligible_for_trial']) {
    assertEquals(mustPay({ createdAt: NEW, accessState: s, purchasesAvailable: true }), true, s);
  }
});

Deno.test('no store (Expo Go, web) never locks: nobody could pay', () => {
  assertEquals(mustPay({ createdAt: NEW, accessState: 'free', purchasesAvailable: false }), false);
});

Deno.test('created date: exact cutoff counts, missing or bad date does not', () => {
  assertEquals(isHardPaywallAccount(HARD_PAYWALL_FROM), true);
  assertEquals(isHardPaywallAccount(new Date(HARD_PAYWALL_FROM).toISOString()), true);
  assertEquals(isHardPaywallAccount(null), false);
  assertEquals(isHardPaywallAccount(undefined), false);
  assertEquals(isHardPaywallAccount('not a date'), false);
});
