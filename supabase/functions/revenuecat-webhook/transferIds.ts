// Picking the real user ids out of a RevenueCat TRANSFER event.
//
// Split out of index.ts so it can be tested directly: index.ts reads env vars
// and calls Deno.serve at module scope, so importing it from a test would start
// a server and throw on the missing webhook secret.
//
// A TRANSFER payload carries ARRAYS, not single ids, because one RevenueCat
// subscriber can have several aliases — typically the anonymous id the SDK
// minted before login, plus the Clerk id we set via Purchases.logIn(). Anonymous
// ids look like "$RCAnonymousID:0f1e2d...", are useless to us (they match no
// user_profiles row), and are NOT guaranteed to come last, so we filter rather
// than index.

/** RevenueCat's placeholder id for a subscriber that never logged in. */
const ANONYMOUS_PREFIX = "$RCAnonymousID:";

export interface TransferIds {
  /** Clerk id the subscription moved TO, or undefined if only anonymous ids were sent. */
  newClerkId?: string;
  /** Clerk id the subscription moved FROM, or undefined if only anonymous ids were sent. */
  oldClerkId?: string;
}

export function pickTransferIds(
  event: { transferred_from?: string[]; transferred_to?: string[] },
): TransferIds {
  const isRealUser = (id: string) => !id.startsWith(ANONYMOUS_PREFIX);
  return {
    newClerkId: (event.transferred_to ?? []).find(isRealUser),
    oldClerkId: (event.transferred_from ?? []).find(isRealUser),
  };
}
