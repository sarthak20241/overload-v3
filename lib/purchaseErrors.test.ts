// Run with: deno test --allow-all lib/purchaseErrors.test.ts
//
// A payment the store is still waiting on must not read as a failure, and a
// real failure must carry the store's reason into analytics.

import { assertEquals } from 'jsr:@std/assert@1';
import { describePurchaseError, isPaymentPending } from './purchaseErrors.ts';

Deno.test('a pending payment is recognised in every shape the bridges send', () => {
  assertEquals(isPaymentPending({ code: '20' }), true);
  assertEquals(isPaymentPending({ code: 20 }), true);
  assertEquals(isPaymentPending({ readableErrorCode: 'PaymentPendingError' }), true);
  assertEquals(isPaymentPending({ userInfo: { code: '20' } }), true);
  assertEquals(isPaymentPending({ userInfo: { readableErrorCode: 'PaymentPendingError' } }), true);
});

Deno.test('a decline, a cancel or a bare Error is not pending', () => {
  assertEquals(isPaymentPending({ code: '2', readableErrorCode: 'StoreProblemError' }), false);
  assertEquals(isPaymentPending({ userCancelled: true, code: '1' }), false);
  assertEquals(isPaymentPending(new Error('boom')), false);
  assertEquals(isPaymentPending(undefined), false);
});

Deno.test("a failure keeps the store's own reason", () => {
  const info = describePurchaseError({
    code: '2',
    readableErrorCode: 'StoreProblemError',
    underlyingErrorMessage: 'Your payment method was declined.',
    message: 'There was a problem with the store.',
  });
  assertEquals(info, {
    code: '2',
    readable: 'StoreProblemError',
    underlying: 'Your payment method was declined.',
    message: 'There was a problem with the store.',
  });
});

Deno.test('a bare Error still reports something', () => {
  assertEquals(describePurchaseError(new Error('boom')), {
    code: null,
    readable: 'Error',
    underlying: null,
    message: 'boom',
  });
});
