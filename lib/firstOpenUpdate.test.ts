// Run with: deno test --allow-all lib/firstOpenUpdate.test.ts
//
// A fresh store install must run the newest update before onboarding, but it
// must never sit on the splash for long, and it must never reload under a
// user who is already in the app.

import { assertEquals } from "jsr:@std/assert@1";
import {
  FIRST_OPEN_MAX_TRIES,
  FRESH_STATE,
  nextState,
  parseState,
  runFirstOpenUpdate,
  shouldCheckOnOpen,
} from "./firstOpenUpdate.ts";

const STORE_BUILD = { isEnabled: true, isEmbeddedLaunch: true, isDev: false };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function steps(opts: {
  available?: boolean;
  isNew?: boolean;
  checkMs?: number;
  fetchMs?: number;
  checkThrows?: boolean;
  rollBack?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      capMs: 50,
      check: async () => {
        calls.push("check");
        await sleep(opts.checkMs ?? 0);
        if (opts.checkThrows) throw new Error("offline");
        return { isAvailable: opts.available ?? false };
      },
      fetch: async () => {
        calls.push("fetch");
        await sleep(opts.fetchMs ?? 0);
        return { isNew: opts.isNew ?? true, isRollBackToEmbedded: opts.rollBack ?? false };
      },
      beforeReload: async () => {
        calls.push("save");
      },
      reload: async () => {
        calls.push("reload");
      },
    },
  };
}

Deno.test("a newer update found in time: saved, then reloaded into", async () => {
  const { calls, steps: s } = steps({ available: true });
  assertEquals(await runFirstOpenUpdate(s), "reloading");
  await sleep(0);
  assertEquals(calls, ["check", "fetch", "save", "reload"]);
});

Deno.test("nothing newer: opens the built-in code, no download", async () => {
  const { calls, steps: s } = steps({ available: false });
  assertEquals(await runFirstOpenUpdate(s), "up_to_date");
  assertEquals(calls, ["check"]);
});

Deno.test("a rollback to the built-in code: already running it, no reload", async () => {
  const { calls, steps: s } = steps({ available: true, isNew: false, rollBack: true });
  assertEquals(await runFirstOpenUpdate(s), "up_to_date");
  assertEquals(calls, ["check", "fetch"]);
});

Deno.test("a failed download (not new, not a rollback) keeps the retries", async () => {
  const { calls, steps: s } = steps({ available: true, isNew: false });
  const outcome = await runFirstOpenUpdate(s);
  assertEquals(outcome, "failed");
  assertEquals(nextState(FRESH_STATE, outcome).done, false);
  assertEquals(calls, ["check", "fetch"]);
});

Deno.test("the app opened another way mid-download: never reloads", async () => {
  // The gate's backstop opened the app while a slow storage read had pushed
  // the cap past it. The download lands inside the cap, after the opening.
  const { calls, steps: s } = steps({ available: true, fetchMs: 20 });
  let open = false;
  setTimeout(() => (open = true), 10);
  const outcome = await runFirstOpenUpdate({ ...s, capMs: 1000, isCancelled: () => open });
  assertEquals(outcome, "timed_out");
  await sleep(30);
  assertEquals(calls, ["check", "fetch"]);
});

Deno.test("already open before it starts: nothing runs", async () => {
  const { calls, steps: s } = steps({ available: true });
  assertEquals(await runFirstOpenUpdate({ ...s, isCancelled: () => true }), "timed_out");
  assertEquals(calls, []);
});

Deno.test("a check that hangs: opens at the cap", async () => {
  const { calls, steps: s } = steps({ available: true, checkMs: 10_000 });
  const t0 = Date.now();
  const outcome = await runFirstOpenUpdate({ ...s, check: () => new Promise(() => {}) });
  assertEquals(outcome, "timed_out");
  assertEquals(Date.now() - t0 < 1000, true);
  assertEquals(calls, []);
});

Deno.test("a download that lands after the cap never reloads the open app", async () => {
  const { calls, steps: s } = steps({ available: true, fetchMs: 120 });
  assertEquals(await runFirstOpenUpdate(s), "timed_out");
  await sleep(200); // the download finishes now, with the app open
  assertEquals(calls, ["check", "fetch"]);
});

Deno.test("offline: the check throws, the app opens at once", async () => {
  const { calls, steps: s } = steps({ checkThrows: true });
  // "failed", not "timed_out": it settled on the error, before the cap.
  assertEquals(await runFirstOpenUpdate(s), "failed");
  assertEquals(calls, ["check"]);
});

Deno.test("shouldCheckOnOpen: only the binary's own code, only first opens", () => {
  assertEquals(shouldCheckOnOpen(STORE_BUILD, FRESH_STATE), true);
  // already running an update: nothing to catch up on
  assertEquals(shouldCheckOnOpen({ ...STORE_BUILD, isEmbeddedLaunch: false }, FRESH_STATE), false);
  assertEquals(shouldCheckOnOpen({ ...STORE_BUILD, isDev: true }, FRESH_STATE), false);
  assertEquals(shouldCheckOnOpen({ ...STORE_BUILD, isEnabled: false }, FRESH_STATE), false);
  assertEquals(shouldCheckOnOpen(STORE_BUILD, { done: true, tries: 1 }), false);
  assertEquals(shouldCheckOnOpen(STORE_BUILD, { done: false, tries: FIRST_OPEN_MAX_TRIES }), false);
});

Deno.test("nextState: an answer ends it, a timeout or failure spends a try", () => {
  assertEquals(nextState(FRESH_STATE, "up_to_date"), { done: true, tries: 1 });
  assertEquals(nextState(FRESH_STATE, "reloading"), { done: true, tries: 1 });
  let s = FRESH_STATE;
  for (let i = 0; i < FIRST_OPEN_MAX_TRIES; i++) s = nextState(s, i % 2 ? "failed" : "timed_out");
  assertEquals(s, { done: false, tries: FIRST_OPEN_MAX_TRIES });
  assertEquals(shouldCheckOnOpen(STORE_BUILD, s), false);
});

Deno.test("parseState: anything unreadable counts as a fresh install", () => {
  assertEquals(parseState(null), FRESH_STATE);
  assertEquals(parseState("not json"), FRESH_STATE);
  assertEquals(parseState('{"tries":"x"}'), FRESH_STATE);
  assertEquals(parseState('{"done":true,"tries":2}'), { done: true, tries: 2 });
});
