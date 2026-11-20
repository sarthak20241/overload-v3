// deno test --allow-all supabase/functions/_shared/lapsePush.test.ts
//
// When Drona sends the "logging went quiet" push, and what it says.

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  decideFoodLapse,
  type LapseFacts,
  lapseWords,
  LAPSE_MAX_GAP,
  LAPSE_MIN_MISSED,
  pushTarget,
  SEND_FROM_HOUR,
  SEND_UNTIL_HOUR,
} from "./lapsePush.ts";

/** Day strings counting back from a day: back("2026-11-20", 1) = "2026-11-19". */
function back(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Logged every day from `from` days back to `to` days back (inclusive). */
const daily = (today: string, from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => back(today, from - i));

const TODAY = "2026-11-21";
const base = (over: Partial<LapseFacts> = {}): LapseFacts => ({
  today: TODAY,
  hour: 11,
  days: daily(TODAY, 30, 3), // logged every day up to 3 days ago (Nov 18)
  lastPushAt: null,
  now: "2026-11-21T05:30:00Z",
  ...over,
});

Deno.test("steady logger, 2 full days missed, inside the send window: send once for that lapse", () => {
  const d = decideFoodLapse(base());
  assertEquals(d.send, true);
  assertEquals(d.lapseKey, "2026-11-18");
  assertEquals(d.missedDays, 2);
});

Deno.test("only 1 day missed: wait", () => {
  const d = decideFoodLapse(base({ days: daily(TODAY, 30, 2) }));
  assertEquals(d.send, false);
  assertEquals(d.reason, "not_lapsed");
});

Deno.test("logged today: never send", () => {
  assertEquals(decideFoodLapse(base({ days: daily(TODAY, 30, 0) })).send, false);
});

Deno.test("never logged steadily (3 of the last 14 days): no push", () => {
  const sparse = [back(TODAY, 3), back(TODAY, 8), back(TODAY, 12)];
  const d = decideFoodLapse(base({ days: sparse }));
  assertEquals(d.send, false);
  assertEquals(d.reason, "not_steady");
});

Deno.test("gone longer than the max gap: leave them be (no blast on first deploy)", () => {
  const d = decideFoodLapse(base({ days: daily(TODAY, 40, LAPSE_MAX_GAP + 2) }));
  assertEquals(d.send, false);
  assertEquals(d.reason, "too_old");
});

Deno.test("quiet hours: nothing before the window or from its end on", () => {
  assertEquals(decideFoodLapse(base({ hour: SEND_FROM_HOUR - 1 })).reason, "quiet_hours");
  assertEquals(decideFoodLapse(base({ hour: SEND_UNTIL_HOUR })).reason, "quiet_hours");
  assertEquals(decideFoodLapse(base({ hour: 2 })).send, false);
  assertEquals(decideFoodLapse(base({ hour: SEND_FROM_HOUR })).send, true);
  assertEquals(decideFoodLapse(base({ hour: SEND_UNTIL_HOUR - 1 })).send, true);
});

Deno.test("a lapse push in the last 7 days holds the next one, even for a new lapse", () => {
  const d = decideFoodLapse(base({ lastPushAt: "2026-11-17T05:30:00Z" }));
  assertEquals(d.send, false);
  assertEquals(d.reason, "cooldown");
  assertEquals(decideFoodLapse(base({ lastPushAt: "2026-11-13T05:00:00Z" })).send, true);
});

Deno.test("days come in any order and with repeats", () => {
  const days = [...daily(TODAY, 30, 3)].reverse();
  days.push(back(TODAY, 3), back(TODAY, 5));
  assertEquals(decideFoodLapse(base({ days })).lapseKey, "2026-11-18");
});

Deno.test("no food days at all: no push", () => {
  assertEquals(decideFoodLapse(base({ days: [] })).reason, "no_logs");
});

Deno.test("minimum missed days is 2", () => {
  assertEquals(LAPSE_MIN_MISSED, 2);
});

Deno.test("words: kind, no numbers, no em dashes, signed by Drona, same text for the same lapse", () => {
  for (const user of ["u1", "u2", "u3", "user_3HMF5e736li5FXZU8e1y3cWWyuW", "abc", "zzz"]) {
    const w = lapseWords(user, "2026-11-18");
    assertEquals(w, lapseWords(user, "2026-11-18"));
    assert(w.title.length > 0 && w.title.length <= 40, w.title);
    assert(w.body.length > 0 && w.body.length <= 160, w.body);
    for (const s of [w.title, w.body]) {
      assert(!/\d/.test(s), `no numbers: ${s}`);
      assert(!s.includes("—") && !s.includes("–"), `no dashes: ${s}`);
      assert(!/(calorie|kcal|weight|fail|lazy|should have|guilt)/i.test(s), `no shaming words: ${s}`);
    }
    assertMatch(w.title, /Drona/);
  }
});

Deno.test("tap opens Nutrition", () => {
  assertEquals(pushTarget(), { type: "food_lapse", screen: "nutrition" });
});
