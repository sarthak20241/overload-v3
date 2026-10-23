// What a thrown store purchase error actually means.
//
// Kept free of React Native imports so a Deno test can load it
// (lib/purchaseErrors.test.ts); lib/revenuecat.ts re-exports both helpers.
//
// WHY THIS EXISTS: a pending payment is not a failure. With an Indian card or
// UPI AutoPay mandate (RBI e-mandate), Ask to Buy, or SEPA, the store accepts
// the purchase and waits on someone else to approve it. RevenueCat reports
// that as PAYMENT_PENDING_ERROR (code '20'). Both paywalls treated every
// non-cancel throw as "Purchase failed", so on 2026-09-19 a real production
// trial started 10 seconds AFTER the app had told the buyer it failed. And
// every failure was logged as a bare `reason: 'error'`, so a Google Play order
// that went Pending then Canceled on 2026-10-23 left no cause in analytics.

// PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR from
// @revenuecat/purchases-typescript-internal. Inlined so this module stays
// loadable without the native package (Expo Go, Deno tests).
export const PAYMENT_PENDING_CODE = '20';

/**
 * True when the store deferred the transaction rather than refusing it.
 * The platform bridges disagree on the shape: iOS sends the numeric-string
 * `code`, some versions only set `readableErrorCode`, and the hybrid layer
 * nests both under `userInfo`. Check every spelling rather than one.
 */
// deno-lint-ignore no-explicit-any
export function isPaymentPending(e: any): boolean {
  const code = e?.code ?? e?.userInfo?.code;
  if (code !== undefined && code !== null && String(code) === PAYMENT_PENDING_CODE) return true;
  const readable = e?.readableErrorCode ?? e?.userInfo?.readableErrorCode;
  return String(readable) === 'PaymentPendingError';
}

export interface PurchaseErrorInfo {
  code: string | null;
  readable: string | null;
  underlying: string | null;
  message: string | null;
}

/**
 * The store's own reason, pulled off a thrown purchase or restore error. RC
 * puts the real cause on the error object, not in `message`: `code` (RC's
 * PURCHASES_ERROR_CODE), `readableErrorCode` (e.g. 'StoreProblemError') and
 * `underlyingErrorMessage` (Apple's or Google's own text). Store diagnostics
 * only, never user data.
 */
// deno-lint-ignore no-explicit-any
export function describePurchaseError(e: any): PurchaseErrorInfo {
  const code = e?.code ?? e?.userInfo?.code;
  const readable = e?.readableErrorCode ?? e?.userInfo?.readableErrorCode ?? e?.name;
  const underlying = e?.underlyingErrorMessage ?? e?.userInfo?.underlyingErrorMessage;
  return {
    code: code !== undefined && code !== null ? String(code) : null,
    readable: readable ? String(readable) : null,
    underlying: underlying ? String(underlying).slice(0, 300) : null,
    message: e?.message ? String(e.message).slice(0, 300) : null,
  };
}
