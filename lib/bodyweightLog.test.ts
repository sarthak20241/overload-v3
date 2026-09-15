// Run with: deno test lib/bodyweightLog.test.ts
//
// Manual weight used to live only in AsyncStorage, keyed by the UTC day, with
// the kg/lbs switch acting as a bare label. The server never saw a hand-typed
// weigh-in, so anything reading daily_metrics (readiness, the coach, Drona
// cards) thought a daily hand-logger never weighed in. These tests pin the
// three rules the fix rests on: the LOCAL day, real kilograms on the server,
// and a pending edit beating the server copy of the same day.

import { assertEquals } from "jsr:@std/assert@1";
import {
  dayToEntryDate,
  fromKg,
  legacyLogToRows,
  localDayISO,
  mergeSeries,
  toKg,
  withPending,
} from "./bodyweightLog.ts";
import { deleteWeight, flushWeights, loadWeights, logWeight, type WeightDeps } from "./bodyweightLog.ts";

Deno.test("localDayISO uses the local calendar day, not the UTC day", () => {
  // 00:30 local on 15 Sep. In any zone east of UTC the UTC day is still 14 Sep,
  // which is what the old toISOString().slice(0, 10) key recorded.
  const d = new Date(2026, 8, 15, 0, 30);
  assertEquals(localDayISO(d), "2026-09-15");
});

Deno.test("lbs are converted to kg for the server and back for display", () => {
  assertEquals(toKg(165, "lbs"), 74.84);
  // The round trip must give back what was typed.
  for (const lbs of [120, 165, 165.5, 199.9, 250]) assertEquals(fromKg(toKg(lbs, "lbs")!, "lbs"), lbs);
  assertEquals(toKg(75, "kg"), 75);
  assertEquals(fromKg(74.84, "lbs"), 165);
  assertEquals(fromKg(74.84, "kg"), 74.8);
});

Deno.test("toKg refuses values no scale produces", () => {
  assertEquals(toKg(0, "kg"), null);
  assertEquals(toKg(-3, "kg"), null);
  assertEquals(toKg(Number.NaN, "kg"), null);
  assertEquals(toKg(7, "kg"), null); // a half-typed "78"
  assertEquals(toKg(900, "kg"), null);
});

Deno.test("legacy log: one row per local day, the last entry of the day wins", () => {
  const log = [
    { date: new Date(2026, 8, 10, 7, 0).toISOString(), weight: 80 },
    { date: new Date(2026, 8, 10, 21, 0).toISOString(), weight: 81 },
    { date: new Date(2026, 8, 11, 7, 0).toISOString(), weight: 79.5 },
    { date: "not a date", weight: 70 },
    { date: new Date(2026, 8, 12, 7, 0).toISOString(), weight: 0 },
  ];
  assertEquals(legacyLogToRows(log, "kg"), [
    { day: "2026-09-10", kg: 81 },
    { day: "2026-09-11", kg: 79.5 },
  ]);
});

Deno.test("mergeSeries: pending edits win their day, a pending delete hides it", () => {
  const server = [
    { metric_date: "2026-09-10", value: 80 },
    { metric_date: "2026-09-11", value: "79.6" }, // PostgREST numeric arrives as a string
    { metric_date: "2026-09-12", value: 79 },
  ];
  const pending = [
    { day: "2026-09-11", kg: 79.2 },
    { day: "2026-09-12", kg: null },
    { day: "2026-09-13", kg: 78.8 },
  ];
  assertEquals(mergeSeries(server, pending, "kg"), [
    { date: dayToEntryDate("2026-09-10"), weight: 80 },
    { date: dayToEntryDate("2026-09-11"), weight: 79.2 },
    { date: dayToEntryDate("2026-09-13"), weight: 78.8 },
  ]);
});

Deno.test("dayToEntryDate lands on local noon of that day", () => {
  const d = new Date(dayToEntryDate("2026-09-15"));
  assertEquals([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 8, 15, 12]);
});

Deno.test("withPending replaces an earlier pending edit for the same day", () => {
  const a = withPending([], { day: "2026-09-15", kg: 80 });
  const b = withPending(a, { day: "2026-09-15", kg: 79.9 });
  const c = withPending(b, { day: "2026-09-14", kg: null });
  assertEquals(c, [{ day: "2026-09-15", kg: 79.9 }, { day: "2026-09-14", kg: null }]);
});

// ─── Sync core, against an in-memory store and a fake server ────────────────


function fakeDeps(opts: { legacy?: { date: string; weight: number }[]; unit?: "kg" | "lbs"; online?: boolean } = {}) {
  const mem = new Map<string, string>();
  const server = new Map<string, number>();
  const state = { online: opts.online ?? true, legacy: opts.legacy ?? [] };
  const guard = () => { if (!state.online) throw new Error("offline"); };
  const deps: WeightDeps = {
    userId: "user_test",
    unit: opts.unit ?? "kg",
    store: {
      getItem: (k) => Promise.resolve(mem.get(k) ?? null),
      setItem: (k, v) => { mem.set(k, v); return Promise.resolve(); },
    },
    db: {
      upsert: (rows, { keepExisting }) => {
        guard();
        for (const r of rows) if (!(keepExisting && server.has(r.day))) server.set(r.day, r.kg);
        return Promise.resolve();
      },
      deleteDay: (day) => { guard(); server.delete(day); return Promise.resolve(); },
      loadRows: () => { guard(); return Promise.resolve([...server].map(([metric_date, value]) => ({ metric_date, value }))); },
    },
    legacy: {
      load: () => Promise.resolve(state.legacy),
      clear: () => { state.legacy = []; return Promise.resolve(); },
    },
  };
  return { deps, server, state };
}

Deno.test("a weigh-in reaches the server in kg on the local day", async () => {
  const { deps, server } = fakeDeps({ unit: "lbs" });
  const out = await logWeight(deps, 165, new Date(2026, 8, 15, 0, 30));
  await flushWeights(deps); // waits for the background upload logWeight started
  assertEquals([...server], [["2026-09-15", 74.84]]);
  assertEquals(out?.map((e) => e.weight), [165]);
});

Deno.test("offline: the weigh-in shows now and syncs on the next flush", async () => {
  const { deps, server, state } = fakeDeps({ online: false });
  const out = await logWeight(deps, 80, new Date(2026, 8, 15, 8));
  assertEquals(out?.map((e) => e.weight), [80]);
  assertEquals(server.size, 0);
  state.online = true;
  assertEquals(await flushWeights(deps), 0);
  assertEquals([...server], [["2026-09-15", 80]]);
});

Deno.test("the old device log is uploaded once and never overwrites a server day", async () => {
  const { deps, server, state } = fakeDeps({
    legacy: [
      { date: new Date(2026, 8, 1, 7).toISOString(), weight: 82 },
      { date: new Date(2026, 8, 2, 7).toISOString(), weight: 81.5 },
    ],
  });
  server.set("2026-09-02", 81.2); // a HealthKit reading for that day
  await flushWeights(deps);
  assertEquals([...server].sort(), [["2026-09-01", 82], ["2026-09-02", 81.2]]);
  assertEquals(state.legacy.length, 0);
});

Deno.test("the old device log stays on the phone when the upload fails", async () => {
  const { deps, state } = fakeDeps({ online: false, legacy: [{ date: new Date(2026, 8, 1, 7).toISOString(), weight: 82 }] });
  await flushWeights(deps);
  assertEquals(state.legacy.length, 1);
});

Deno.test("delete removes the day from the server and the series", async () => {
  const { deps, server } = fakeDeps();
  await logWeight(deps, 80, new Date(2026, 8, 14, 8));
  await logWeight(deps, 79.8, new Date(2026, 8, 15, 8));
  const out = await deleteWeight(deps, "2026-09-14");
  await flushWeights(deps);
  assertEquals([...server], [["2026-09-15", 79.8]]);
  assertEquals(out.map((e) => e.weight), [79.8]);
  assertEquals((await loadWeights(deps)).length, 1);
});

Deno.test("logWeight returns before the server answers", async () => {
  const { deps } = fakeDeps();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realUpsert = deps.db.upsert;
  deps.db.upsert = async (rows, opts) => { await gate; return realUpsert(rows, opts); };
  const out = await logWeight(deps, 80, new Date(2026, 8, 15, 8)); // would hang if it waited
  assertEquals(out?.map((e) => e.weight), [80]);
  release();
  await flushWeights(deps);
});

Deno.test("an upload finishing mid-save never erases the new save", async () => {
  // Found by the delete test: the first upload re-read the pending list, a
  // second weigh-in was saved, then the upload wrote back its stale copy.
  const { deps, server } = fakeDeps();
  await logWeight(deps, 80, new Date(2026, 8, 14, 8));
  await logWeight(deps, 79.8, new Date(2026, 8, 15, 8));
  await flushWeights(deps);
  assertEquals([...server].sort(), [["2026-09-14", 80], ["2026-09-15", 79.8]]);
});

Deno.test("a half-typed value is ignored", async () => {
  const { deps, server } = fakeDeps();
  assertEquals(await logWeight(deps, 7), null);
  assertEquals(server.size, 0);
});
