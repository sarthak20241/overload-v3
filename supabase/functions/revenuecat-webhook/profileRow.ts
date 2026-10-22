// Make sure a buyer has a user_profiles row before a tier is written to it.
//
// Split out of index.ts for the same reason as transferIds.ts: index.ts reads
// env vars and calls Deno.serve at module scope, so a test cannot import it.
//
// WHY THIS EXISTS (found 2026-10-22 from a real Android purchase):
// the app creates user_profiles rows lazily, on the first saved intake answer,
// nutrition target or XP award. A signed-in user who buys before any of those
// has NO row. Every grant here was update-only, so it matched 0 rows, threw
// for a retry, and the retries could never succeed: Google took the trial
// mandate, the app said "Purchase received", and Pro never arrived.
//
// Inserting just the id is safe. Every other column has a default (tier
// 'free', level 1, name ''), and onboarding's legacy-user check treats a row
// with no intake fields as "no data yet", so nobody skips onboarding because
// of it. ignoreDuplicates keeps an existing row untouched.
//
// Only real Clerk ids get a row. A RevenueCat anonymous id ($RCAnonymousID:…)
// means logIn never ran; creating a row for it would strand the tier on an
// account nobody can sign in to, so those keep the throw-and-retry path.

export interface ProfileUpserter {
  from(table: "user_profiles"): {
    upsert(
      row: { clerk_user_id: string },
      opts: { onConflict: string; ignoreDuplicates: boolean },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

export function isClerkUserId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^user_[A-Za-z0-9]+$/.test(id);
}

/** Returns true when a row now exists (created or already there). */
export async function ensureProfileRow(
  db: ProfileUpserter,
  clerkUserId: string | null | undefined,
): Promise<boolean> {
  if (!isClerkUserId(clerkUserId)) return false;
  const { error } = await db
    .from("user_profiles")
    .upsert({ clerk_user_id: clerkUserId }, { onConflict: "clerk_user_id", ignoreDuplicates: true });
  if (error) throw new Error(`profile create failed for ${clerkUserId}: ${error.message}`);
  return true;
}
