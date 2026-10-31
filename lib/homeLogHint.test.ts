// Run with: deno test lib/homeLogHint.test.ts
//
// The pill beside the dashboard's log button: which words it says, and when it
// gets out of the way.

import { assertEquals } from "jsr:@std/assert@1";
import {
  HOME_LOG_HINT_FIRST,
  HOME_LOG_HINT_MAX_TAPS,
  HOME_LOG_HINT_NEXT,
  homeLogHint,
  homeLogTapsKey,
  parseTaps,
  type HomeLogHintFacts,
} from "./homeLogHint.ts";

const fresh: HomeLogHintFacts = { ready: true, everLogged: false, loggedToday: false, taps: 0 };

Deno.test("a user with no food logs is asked for their first meal", () => {
  assertEquals(homeLogHint(fresh), HOME_LOG_HINT_FIRST);
});

Deno.test("a user who has logged before, but not today, is asked for the next one", () => {
  assertEquals(homeLogHint({ ...fresh, everLogged: true }), HOME_LOG_HINT_NEXT);
});

Deno.test("food logged today hides the pill", () => {
  assertEquals(homeLogHint({ ...fresh, everLogged: true, loggedToday: true }), null);
});

Deno.test("a few taps on the button hide the pill for good", () => {
  assertEquals(homeLogHint({ ...fresh, taps: HOME_LOG_HINT_MAX_TAPS - 1 }), HOME_LOG_HINT_FIRST);
  assertEquals(homeLogHint({ ...fresh, taps: HOME_LOG_HINT_MAX_TAPS }), null);
  assertEquals(homeLogHint({ ...fresh, everLogged: true, taps: HOME_LOG_HINT_MAX_TAPS + 4 }), null);
});

Deno.test("nothing shows until the reads have settled", () => {
  assertEquals(homeLogHint({ ...fresh, ready: false }), null);
});

Deno.test("the copy is short and has no em dash", () => {
  for (const s of [HOME_LOG_HINT_FIRST, HOME_LOG_HINT_NEXT]) {
    assertEquals(s.includes("—"), false);
    assertEquals(s.length <= 22, true);
  }
});

Deno.test("the tap count is per user and survives junk", () => {
  assertEquals(homeLogTapsKey("user_a") === homeLogTapsKey("user_b"), false);
  assertEquals(parseTaps(null), 0);
  assertEquals(parseTaps("nope"), 0);
  assertEquals(parseTaps("-2"), 0);
  assertEquals(parseTaps("2"), 2);
});
