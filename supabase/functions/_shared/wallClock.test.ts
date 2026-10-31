import { assertEquals } from "jsr:@std/assert@1";
import { cronDays } from "./wallClock.ts";

// 2026-10-25 20:00 UTC is already 2026-10-26 in Kolkata.
const NOW = new Date("2026-10-25T20:00:00Z");

Deno.test("cronDays: a saved zone sets the local day", () => {
  assertEquals(cronDays([{ clerk_user_id: "u1", timezone: "Asia/Kolkata" }], NOW), [
    { userId: "u1", tz: "Asia/Kolkata", day: "2026-10-26" },
  ]);
});

Deno.test("cronDays: no saved zone is read in UTC, not skipped", () => {
  assertEquals(
    cronDays([
      { clerk_user_id: "u1", timezone: null },
      { clerk_user_id: "u2", timezone: "" },
      { clerk_user_id: "u3", timezone: "Not/AZone" },
    ], NOW),
    [
      { userId: "u1", tz: "UTC", day: "2026-10-25" },
      { userId: "u2", tz: "UTC", day: "2026-10-25" },
      { userId: "u3", tz: "UTC", day: "2026-10-25" },
    ],
  );
});

Deno.test("cronDays: a row with no user id is dropped", () => {
  assertEquals(cronDays([{ clerk_user_id: null, timezone: "UTC" }], NOW), []);
});
