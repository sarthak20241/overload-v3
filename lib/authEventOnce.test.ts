// Run with: deno test --allow-all lib/authEventOnce.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { claimAuthEvent, clearSSOMethod, noteSSOMethod, takeSSOMethod } from "./authEventOnce.ts";

Deno.test("one session is reported once, whichever path gets there first", () => {
  assertEquals(claimAuthEvent("sess_a"), true); // sso-callback on Android
  assertEquals(claimAuthEvent("sess_a"), false); // runSSO resolving after it
  assertEquals(claimAuthEvent("sess_b"), true); // a later, separate sign-in
});

Deno.test("no session id: never blocked", () => {
  assertEquals(claimAuthEvent(null), true);
  assertEquals(claimAuthEvent(undefined), true);
});

Deno.test("the callback reports the provider once, then forgets it", () => {
  assertEquals(takeSSOMethod(), "oauth_callback");
  noteSSOMethod("google");
  assertEquals(takeSSOMethod(), "google");
  // A later cold-start deep link must not inherit the old provider.
  assertEquals(takeSSOMethod(), "oauth_callback");
  noteSSOMethod("apple");
  clearSSOMethod();
  assertEquals(takeSSOMethod(), "oauth_callback");
});

Deno.test("an old note is ignored", () => {
  noteSSOMethod("google", 0);
  assertEquals(takeSSOMethod(11 * 60 * 1000), "oauth_callback");
});
