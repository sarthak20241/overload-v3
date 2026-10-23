// Run with: deno test supabase/functions/revenuecat-webhook/profileRow.test.ts
//
// The first test is the production bug: a signed-in buyer with no
// user_profiles row must get one, or the tier update matches 0 rows forever.

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ensureProfileRow, isClerkUserId, type ProfileUpserter } from "./profileRow.ts";

function fakeDb(error: { message: string } | null = null) {
  const calls: { row: unknown; opts: unknown }[] = [];
  const db: ProfileUpserter = {
    from: () => ({
      upsert: (row, opts) => {
        calls.push({ row, opts });
        return Promise.resolve({ error });
      },
    }),
  };
  return { db, calls };
}

Deno.test("a signed-in buyer with no profile row gets one, without touching an existing row", async () => {
  const { db, calls } = fakeDb();
  assertEquals(await ensureProfileRow(db, "user_3L3bZGoeE74y6FWQA7mPWt0dkaP"), true);
  assertEquals(calls, [{
    row: { clerk_user_id: "user_3L3bZGoeE74y6FWQA7mPWt0dkaP" },
    opts: { onConflict: "clerk_user_id", ignoreDuplicates: true },
  }]);
});

Deno.test("an anonymous RevenueCat id never gets a row", async () => {
  const { db, calls } = fakeDb();
  assertEquals(await ensureProfileRow(db, "$RCAnonymousID:8f2c1d0e9a7b4c3d"), false);
  assertEquals(await ensureProfileRow(db, undefined), false);
  assertEquals(calls.length, 0);
});

Deno.test("a failed insert throws so RevenueCat retries", async () => {
  const { db } = fakeDb({ message: "boom" });
  await assertRejects(() => ensureProfileRow(db, "user_abc123"), Error, "boom");
});

Deno.test("only user_ ids count as Clerk ids", () => {
  assertEquals(isClerkUserId("user_3Gt86sdnx6Ke3Fuw4TFsOWV7i3H"), true);
  assertEquals(isClerkUserId("$RCAnonymousID:abc"), false);
  assertEquals(isClerkUserId("user_"), false);
  assertEquals(isClerkUserId("user_abc; drop"), false);
  assertEquals(isClerkUserId(null), false);
});
