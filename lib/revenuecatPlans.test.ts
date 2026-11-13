// deno test --allow-all lib/revenuecatPlans.test.ts
//
// Which plan a store package is. The expensive mistake: a Connect product
// sold as Pro (the buyer pays $14.99 and gets no Drona), or the reverse.
import { assertEquals } from 'jsr:@std/assert';
import { isConnectPlan, packageToPlanKey } from './planKeys.ts';

const pkg = (identifier: string, productId: string, packageType = 'CUSTOM') =>
  ({ identifier, packageType, product: { identifier: productId, priceString: '$1', price: 1, currencyCode: 'USD' } }) as any;

Deno.test('Pro packages map as before', () => {
  assertEquals(packageToPlanKey(pkg('$rc_annual', 'overload_annual', 'ANNUAL')), 'annual');
  assertEquals(packageToPlanKey(pkg('$rc_monthly', 'overload_monthly:monthly', 'MONTHLY')), 'monthly');
  assertEquals(packageToPlanKey(pkg('$rc_lifetime', 'overload_founding_lifetime', 'LIFETIME')), 'founding_lifetime');
});

Deno.test('Connect packages map by product, Apple and Play ids', () => {
  assertEquals(packageToPlanKey(pkg('connect_annual', 'overload_connect_annual')), 'connect_annual');
  assertEquals(packageToPlanKey(pkg('connect_monthly', 'overload_connect_monthly:monthly')), 'connect_monthly');
  assertEquals(packageToPlanKey(pkg('connect_lifetime', 'overload_connect_lifetime')), 'connect_lifetime');
});

Deno.test('a Connect product set up as a Pro package is still Connect', () => {
  assertEquals(packageToPlanKey(pkg('$rc_annual', 'overload_connect_annual', 'ANNUAL')), 'connect_annual');
});

Deno.test('a Connect package id over a Pro product is rejected, not sold as Connect', () => {
  assertEquals(packageToPlanKey(pkg('connect_annual', 'overload_annual')), null);
});

Deno.test('isConnectPlan', () => {
  assertEquals(isConnectPlan('connect_lifetime'), true);
  assertEquals(isConnectPlan('annual'), false);
});
