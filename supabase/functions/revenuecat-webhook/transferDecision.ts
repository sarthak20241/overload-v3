// What a RevenueCat TRANSFER should actually do to the two user_profiles rows.
//
// Split out of index.ts for the same reason as transferIds.ts: index.ts reads
// env vars and calls Deno.serve at module scope, so a test cannot import it.
//
// WHY THIS EXISTS (bug found 2026-09-12 from a real sandbox purchase):
// the old handler copied the SOURCE row's tier onto the TARGET unconditionally
// and left the source untouched. Both halves were wrong.
//
//   1. A TRANSFER event carries no product_id — only the two id arrays — so
//      copying was the only way to know what moved. But the source row can be
//      STALE. One Apple ID bought Founding Lifetime in August, then bought
//      MONTHLY on a fresh Clerk account in September. Apple moved the receipt,
//      RevenueCat fired TRANSFER *and* INITIAL_PURCHASE, and whichever landed
//      last won. TRANSFER landed last, so it pasted the August lifetime over
//      the September monthly. The tell was two rows sharing tier_started_at to
//      the microsecond — a copy, not two independent events.
//
//   2. A transfer MOVES a receipt; it does not clone it. Leaving the source on
//      its old tier meant one purchase entitled two accounts forever, and for
//      founding_lifetime it also slipped past founding_tier_claims, which still
//      counted a single claim.
//
// So: never overwrite an entitlement that is at least as new as the one being
// transferred (that newer one came from a real product event and knows its own
// product), and always release the source.
//
// The source can get its access back by tapping Restore Purchases, which makes
// RevenueCat transfer the receipt again in the other direction.

/** Only the fields the decision needs. */
export interface TransferProfile {
  tier?: string | null;
  tier_started_at?: string | null;
}

export type TransferAction =
  /** Copy the source's entitlement onto the target, then release the source. */
  | "move"
  /** Target already holds an entitlement at least as new; only release the source. */
  | "release_only"
  /** Source has nothing to give. Leave both rows alone. */
  | "none";

export interface TransferDecision {
  action: TransferAction;
  /** Logged verbatim, so a production log line explains itself. */
  reason: string;
}

function startedAtMs(profile: TransferProfile | null | undefined): number {
  const parsed = Date.parse(profile?.tier_started_at ?? "");
  // An entitlement with no start time is treated as infinitely old, so it can
  // never win a comparison against one that is dated.
  return Number.isNaN(parsed) ? 0 : parsed;
}

function hasPaidTier(profile: TransferProfile | null | undefined): boolean {
  return !!profile?.tier && profile.tier !== "free";
}

export function decideTransfer(
  source: TransferProfile | null | undefined,
  target: TransferProfile | null | undefined,
): TransferDecision {
  if (!hasPaidTier(source)) {
    return {
      action: "none",
      reason: "source has no paid tier; the next RENEWAL will activate the target",
    };
  }

  // The target keeps what it has unless the incoming entitlement is strictly
  // newer. Equal timestamps keep the target too: that is the replay case, where
  // re-processing the same TRANSFER must not undo a later purchase.
  if (hasPaidTier(target) && !(startedAtMs(source) > startedAtMs(target))) {
    return {
      action: "release_only",
      reason:
        `target already on tier=${target!.tier} (started ${target!.tier_started_at ?? "unknown"}) ` +
        `which is not older than the transferred tier=${source!.tier} ` +
        `(started ${source!.tier_started_at ?? "unknown"}); keeping the target's tier`,
    };
  }

  return {
    action: "move",
    reason: `moving tier=${source!.tier} to the target and releasing the source`,
  };
}
