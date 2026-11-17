// Run with: deno test --allow-all lib/authEventOnce.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { claimAuthEvent } from "./authEventOnce.ts";

Deno.test("one session is reported once, whichever path gets there first", () => {
  assertEquals(claimAuthEvent("sess_a"), true); // sso-callback on Android
  assertEquals(claimAuthEvent("sess_a"), false); // runSSO resolving after it
  assertEquals(claimAuthEvent("sess_b"), true); // a later, separate sign-in
});

Deno.test("no session id: never blocked", () => {
  assertEquals(claimAuthEvent(null), true);
  assertEquals(claimAuthEvent(undefined), true);
});
