// Run with: deno test supabase/functions/revenuecat-webhook/transferIds.test.ts
//
// Covers the id-picking a TRANSFER event depends on. Getting this wrong is
// expensive and silent: pick an anonymous id and the follow-up UPDATE matches
// zero rows, so a paying customer sits on `free` until their next renewal.

import { assertEquals } from "jsr:@std/assert@1";
import { pickTransferIds } from "./transferIds.ts";

const ANON = "$RCAnonymousID:8f2c1b9e4a7d";
const ANON_2 = "$RCAnonymousID:1a2b3c4d5e6f";
const OLD_USER = "user_2Xk9pLmQrStUvWxYz01234567";
const NEW_USER = "user_3Gt86sdnx6Ke3Fuw4TFsOWV7i3H";

Deno.test("picks both Clerk ids on a plain account-to-account transfer", () => {
  assertEquals(
    pickTransferIds({ transferred_from: [OLD_USER], transferred_to: [NEW_USER] }),
    { oldClerkId: OLD_USER, newClerkId: NEW_USER },
  );
});

Deno.test("skips an anonymous id that arrives before the real one", () => {
  // The SDK mints an anonymous id before Purchases.logIn(), so both aliases
  // ride along and order is not guaranteed. Indexing [0] would take the anon.
  assertEquals(
    pickTransferIds({
      transferred_from: [ANON, OLD_USER],
      transferred_to: [ANON_2, NEW_USER],
    }),
    { oldClerkId: OLD_USER, newClerkId: NEW_USER },
  );
});

Deno.test("no new Clerk id when the target only has anonymous aliases", () => {
  // Caller must bail here: there is no user_profiles row to grant against.
  const { newClerkId, oldClerkId } = pickTransferIds({
    transferred_from: [OLD_USER],
    transferred_to: [ANON, ANON_2],
  });
  assertEquals(newClerkId, undefined);
  assertEquals(oldClerkId, OLD_USER);
});

Deno.test("no old Clerk id when the source was never logged in", () => {
  // Real case: purchase made before sign-in, then transferred. Nothing to copy
  // from, so the handler falls through and lets the next RENEWAL activate.
  const { newClerkId, oldClerkId } = pickTransferIds({
    transferred_from: [ANON],
    transferred_to: [NEW_USER],
  });
  assertEquals(newClerkId, NEW_USER);
  assertEquals(oldClerkId, undefined);
});

Deno.test("missing arrays are treated as empty, not a crash", () => {
  assertEquals(pickTransferIds({}), { oldClerkId: undefined, newClerkId: undefined });
  assertEquals(
    pickTransferIds({ transferred_to: [NEW_USER] }),
    { oldClerkId: undefined, newClerkId: NEW_USER },
  );
});

Deno.test("empty arrays are treated as empty, not a crash", () => {
  assertEquals(
    pickTransferIds({ transferred_from: [], transferred_to: [] }),
    { oldClerkId: undefined, newClerkId: undefined },
  );
});

Deno.test("an id merely containing the anon marker is still a real user", () => {
  // Guards against switching the prefix check to a substring match.
  const odd = `user_weird${ANON}`;
  assertEquals(pickTransferIds({ transferred_to: [odd] }).newClerkId, odd);
});
