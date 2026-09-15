// Run with: deno test --allow-all lib/bodyLog.test.ts
//
// Weight, body fat and tape measurements used to live only in AsyncStorage,
// keyed by the UTC day, with the unit switches acting as bare labels. The
// server never saw them. These tests pin the rules the move rests on: the
// LOCAL day (or the picked day for measurements), canonical units that
// round-trip, pending edits winning their day, and an upload queue that never
// loses an entry to a race.

import { assertEquals } from "jsr:@std/assert@1";
import {
  bodyFatLog,
  dayToEntryDate,
  type DayValueDb,
  entrySites,
  fromCm,
  fromKg,
  type KeyValueStore,
  legacyDayOf,
  legacyLogToRows,
  legacyMeasurementsToDays,
  localDayISO,
  type MeasurementDb,
  measurementLog,
  mergeDaySeries,
  mergeMeasurements,
  siteOf,
  toBodyFat,
  toCm,
  toKg,
  weightLog,
  withPendingDay,
  withPendingMeasurement,
} from "./bodyLog.ts";

// ─── Days and units ─────────────────────────────────────────────────────────

Deno.test("localDayISO uses the local calendar day, not the UTC day", () => {
  // 00:30 local on 15 Sep. East of UTC the UTC day is still 14 Sep, which is
  // what the old toISOString().slice(0, 10) key recorded.
  assertEquals(localDayISO(new Date(2026, 8, 15, 0, 30)), "2026-09-15");
});

Deno.test("legacyDayOf: a typed moment is its local day, a picked date keeps its date", () => {
  assertEquals(legacyDayOf(new Date(2026, 8, 15, 0, 30).toISOString()), "2026-09-15");
  // The measurements drawer saved new Date('2026-09-15').toISOString(). West of
  // UTC that moment is 14 Sep locally, but the user picked the 15th.
  assertEquals(legacyDayOf("2026-09-15T00:00:00.000Z"), "2026-09-15");
  assertEquals(legacyDayOf("nope"), null);
  assertEquals(legacyDayOf(undefined), null);
});

Deno.test("dayToEntryDate lands on local noon of that day", () => {
  const d = new Date(dayToEntryDate("2026-09-15"));
  assertEquals([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 8, 15, 12]);
});

Deno.test("weight: lbs go to kg and come back as typed", () => {
  assertEquals(toKg(165, "lbs"), 74.84);
  assertEquals(toKg(75, "kg"), 75);
  for (const lbs of [120, 165, 165.5, 199.9, 250]) assertEquals(fromKg(toKg(lbs, "lbs")!, "lbs"), lbs);
  assertEquals(fromKg(74.84, "kg"), 74.8);
});

Deno.test("weight: values no scale shows are refused", () => {
  for (const v of [0, -3, Number.NaN, 7, 900]) assertEquals(toKg(v, "kg"), null);
});

Deno.test("body fat: 0.1 steps, refused outside 2-70", () => {
  assertEquals(toBodyFat(18.44), 18.4);
  for (const v of [0, 1.9, 70.1, Number.NaN]) assertEquals(toBodyFat(v), null);
});

Deno.test("tape: inches go to cm and come back as typed", () => {
  assertEquals(toCm(32, "in"), 81.28);
  for (const inches of [6.5, 14.25, 32, 40.1, 55]) assertEquals(fromCm(toCm(inches, "in")!, "in"), Math.round(inches * 10) / 10);
  for (const v of [0, 1, 400]) assertEquals(toCm(v, "cm"), null);
});

Deno.test("siteOf maps the app's fields to the database sites", () => {
  assertEquals(siteOf("bicepL"), "bicep_l");
  assertEquals(siteOf("calfR"), "calf_r");
  assertEquals(siteOf("waist"), "waist");
});

// ─── Pure series rules ──────────────────────────────────────────────────────

Deno.test("legacy log: one row per local day, the last entry of the day wins", () => {
  const log = [
    { date: new Date(2026, 8, 10, 7, 0).toISOString(), value: 80 },
    { date: new Date(2026, 8, 10, 21, 0).toISOString(), value: 81 },
    { date: new Date(2026, 8, 11, 7, 0).toISOString(), value: 79.5 },
    { date: "not a date", value: 70 },
    { date: new Date(2026, 8, 12, 7, 0).toISOString(), value: 0 },
  ];
  assertEquals(legacyLogToRows(log, (v) => toKg(v, "kg")), [
    { day: "2026-09-10", value: 81 },
    { day: "2026-09-11", value: 79.5 },
  ]);
});

Deno.test("mergeDaySeries: pending edits win their day, a pending delete hides it", () => {
  const server = [
    { metric_date: "2026-09-10", value: 80 },
    { metric_date: "2026-09-11", value: "79.6" }, // PostgREST numeric arrives as a string
    { metric_date: "2026-09-12", value: 79 },
  ];
  const pending = [
    { day: "2026-09-11", value: 79.2 },
    { day: "2026-09-12", value: null },
    { day: "2026-09-13", value: 78.8 },
  ];
  assertEquals(mergeDaySeries(server, pending, (v) => v), [
    { date: dayToEntryDate("2026-09-10"), value: 80 },
    { date: dayToEntryDate("2026-09-11"), value: 79.2 },
    { date: dayToEntryDate("2026-09-13"), value: 78.8 },
  ]);
});

Deno.test("withPendingDay replaces an earlier pending edit for the same day", () => {
  const a = withPendingDay([], { day: "2026-09-15", value: 80 });
  const b = withPendingDay(a, { day: "2026-09-15", value: 79.9 });
  const c = withPendingDay(b, { day: "2026-09-14", value: null });
  assertEquals(c, [{ day: "2026-09-15", value: 79.9 }, { day: "2026-09-14", value: null }]);
});

Deno.test("entrySites converts typed fields and drops blanks and nonsense", () => {
  assertEquals(entrySites({ id: "x", date: "d", waist: 32, chest: "", neck: 0, hips: "40" }, "in"), { waist: 81.28, hips: 101.6 });
});

Deno.test("legacy measurements: same-day entries merge, the later entry wins a site", () => {
  // The device list is newest first.
  const entries = [
    { id: "b", date: "2026-09-10T00:00:00.000Z", waist: 80 },
    { id: "a", date: "2026-09-10T00:00:00.000Z", waist: 82, chest: 100 },
    { id: "c", date: "2026-09-01T00:00:00.000Z", neck: 38 },
  ];
  assertEquals(legacyMeasurementsToDays(entries, "cm"), [
    { day: "2026-09-01", sites: { neck: 38 } },
    { day: "2026-09-10", sites: { waist: 80, chest: 100 } },
  ]);
});

Deno.test("withPendingMeasurement: saves merge, delete wins, a save after a delete replaces the day", () => {
  let p = withPendingMeasurement([], { day: "d1", sites: { waist: 80 } });
  p = withPendingMeasurement(p, { day: "d1", sites: { chest: 100 } });
  assertEquals(p, [{ day: "d1", sites: { waist: 80, chest: 100 }, replace: false }]);
  p = withPendingMeasurement(p, { day: "d1", sites: null });
  assertEquals(p, [{ day: "d1", sites: null }]);
  p = withPendingMeasurement(p, { day: "d1", sites: { neck: 38 } });
  assertEquals(p, [{ day: "d1", sites: { neck: 38 }, replace: true }]);
});

Deno.test("mergeMeasurements: newest first, pending sites overlay, replace hides old sites", () => {
  const rows = [
    { measured_on: "2026-09-01", site: "waist", value_cm: "82.00" },
    { measured_on: "2026-09-10", site: "waist", value_cm: 80 },
    { measured_on: "2026-09-10", site: "bicep_l", value_cm: 35 },
    { measured_on: "2026-09-10", site: "not_a_site", value_cm: 1 },
  ];
  assertEquals(mergeMeasurements(rows, [{ day: "2026-09-10", sites: { chest: 100 } }], "cm"), [
    { id: "2026-09-10", date: dayToEntryDate("2026-09-10"), bicepL: 35, chest: 100, waist: 80 },
    { id: "2026-09-01", date: dayToEntryDate("2026-09-01"), waist: 82 },
  ].map((e) => ({ ...e })));
  const replaced = mergeMeasurements(rows, [{ day: "2026-09-10", sites: { chest: 100 }, replace: true }], "cm");
  assertEquals(replaced[0], { id: "2026-09-10", date: dayToEntryDate("2026-09-10"), chest: 100 });
  assertEquals(mergeMeasurements(rows, [{ day: "2026-09-01", sites: null }], "in").map((e) => e.id), ["2026-09-10"]);
});

// ─── The upload queue, against an in-memory store and a fake server ─────────

function memStore(): KeyValueStore {
  const mem = new Map<string, string>();
  return { getItem: (k) => Promise.resolve(mem.get(k) ?? null), setItem: (k, v) => { mem.set(k, v); return Promise.resolve(); } };
}

let uid = 0;
function fakeDayDb(state: { online: boolean }) {
  const server = new Map<string, number>();
  const guard = () => { if (!state.online) throw new Error("offline"); };
  const db: DayValueDb = {
    upsert: (rows, { keepExisting }) => {
      guard();
      for (const r of rows) if (!(keepExisting && server.has(r.day))) server.set(r.day, r.value);
      return Promise.resolve();
    },
    deleteDay: (day) => { guard(); server.delete(day); return Promise.resolve(); },
    loadRows: () => { guard(); return Promise.resolve([...server].map(([metric_date, value]) => ({ metric_date, value }))); },
  };
  return { db, server };
}

function fakeWeight(opts: { legacy?: { date: string; weight: number }[]; unit?: "kg" | "lbs"; online?: boolean } = {}) {
  const state = { online: opts.online ?? true, legacy: opts.legacy ?? [] };
  const { db, server } = fakeDayDb(state);
  const log = weightLog({
    userId: `user_${++uid}`,
    unit: opts.unit ?? "kg",
    store: memStore(),
    db,
    legacy: { load: () => Promise.resolve(state.legacy), clear: () => { state.legacy = []; return Promise.resolve(); } },
  });
  return { log, db, server, state };
}

Deno.test("weight: a weigh-in reaches the server in kg on the local day", async () => {
  const { log, server } = fakeWeight({ unit: "lbs" });
  const out = await log.log(165, new Date(2026, 8, 15, 0, 30));
  await log.flush(); // waits for the background upload log() started
  assertEquals([...server], [["2026-09-15", 74.84]]);
  assertEquals(out?.map((e) => e.weight), [165]);
});

Deno.test("weight: offline, the weigh-in shows now and syncs on the next flush", async () => {
  const { log, server, state } = fakeWeight({ online: false });
  const out = await log.log(80, new Date(2026, 8, 15, 8));
  assertEquals(out?.map((e) => e.weight), [80]);
  assertEquals(server.size, 0);
  state.online = true;
  assertEquals(await log.flush(), 0);
  assertEquals([...server], [["2026-09-15", 80]]);
});

Deno.test("weight: the old device log uploads once and never overwrites a server day", async () => {
  const { log, server, state } = fakeWeight({
    legacy: [
      { date: new Date(2026, 8, 1, 7).toISOString(), weight: 82 },
      { date: new Date(2026, 8, 2, 7).toISOString(), weight: 81.5 },
    ],
  });
  server.set("2026-09-02", 81.2); // a HealthKit reading for that day
  await log.flush();
  assertEquals([...server].sort(), [["2026-09-01", 82], ["2026-09-02", 81.2]]);
  assertEquals(state.legacy.length, 0);
});

Deno.test("weight: the old device log stays on the phone when the upload fails", async () => {
  const { log, state } = fakeWeight({ online: false, legacy: [{ date: new Date(2026, 8, 1, 7).toISOString(), weight: 82 }] });
  await log.flush();
  assertEquals(state.legacy.length, 1);
});

Deno.test("weight: delete removes the day from the server and the series", async () => {
  const { log, server } = fakeWeight();
  await log.log(80, new Date(2026, 8, 14, 8));
  await log.log(79.8, new Date(2026, 8, 15, 8));
  const out = await log.remove("2026-09-14");
  await log.flush();
  assertEquals([...server], [["2026-09-15", 79.8]]);
  assertEquals(out.map((e) => e.weight), [79.8]);
  assertEquals((await log.load()).length, 1);
});

Deno.test("weight: an upload finishing mid-save never erases the new save", async () => {
  // Found by the delete test: the first upload re-read the pending list, a
  // second weigh-in was saved, then the upload wrote back its stale copy.
  const { log, server } = fakeWeight();
  await log.log(80, new Date(2026, 8, 14, 8));
  await log.log(79.8, new Date(2026, 8, 15, 8));
  await log.flush();
  assertEquals([...server].sort(), [["2026-09-14", 80], ["2026-09-15", 79.8]]);
});

Deno.test("weight: forced interleaving, an upload's cleanup cannot erase a save made during it", async () => {
  // The exact bad timing: a save reads the pending list, the upload's cleanup
  // reads the same list, the save writes, then the cleanup writes its stale
  // copy. A read returns what was stored when it started, a tick later; writing
  // an empty list is slow, so without a lock
  // the cleanup's write lands last and the second weigh-in is never uploaded.
  const mem = new Map<string, string>();
  const store: KeyValueStore = {
    getItem: async (k) => { const v = mem.get(k) ?? null; await new Promise((r) => setTimeout(r, 0)); return v; },
    setItem: async (k, v) => { if (v === "[]") await new Promise((r) => setTimeout(r, 20)); mem.set(k, v); },
  };
  const state = { online: true };
  const { db, server } = fakeDayDb(state);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realUpsert = db.upsert;
  let first = true;
  db.upsert = async (rows, opts) => { if (first) { first = false; await gate; } return realUpsert(rows, opts); };
  const log = weightLog({ userId: `user_${++uid}`, unit: "kg", store, db, legacy: { load: () => Promise.resolve([]), clear: () => Promise.resolve() } });
  await log.log(80, new Date(2026, 8, 14, 8)); // its upload now waits on the gate
  release();
  await log.log(79.8, new Date(2026, 8, 15, 8));
  await new Promise((r) => setTimeout(r, 60));
  await log.flush();
  assertEquals([...server].sort(), [["2026-09-14", 80], ["2026-09-15", 79.8]]);
});

Deno.test("weight: log returns before the server answers", async () => {
  const { log, db } = fakeWeight();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realUpsert = db.upsert;
  db.upsert = async (rows, opts) => { await gate; return realUpsert(rows, opts); };
  const out = await log.log(80, new Date(2026, 8, 15, 8)); // would hang if it waited
  assertEquals(out?.map((e) => e.weight), [80]);
  release();
  await log.flush();
});

Deno.test("weight: a half-typed value is ignored", async () => {
  const { log, server } = fakeWeight();
  assertEquals(await log.log(7), null);
  assertEquals(server.size, 0);
});

Deno.test("body fat: logs to its own series, uploads its old log, refuses nonsense", async () => {
  const state = { online: true, legacy: [{ date: new Date(2026, 8, 1, 7).toISOString(), bodyFat: 21.3 }] };
  const { db, server } = fakeDayDb(state);
  const log = bodyFatLog({
    userId: `user_${++uid}`,
    store: memStore(),
    db,
    legacy: { load: () => Promise.resolve(state.legacy), clear: () => { state.legacy = []; return Promise.resolve(); } },
  });
  assertEquals(await log.log(95), null);
  const out = await log.log(18.44, new Date(2026, 8, 15, 8));
  await log.flush();
  assertEquals([...server].sort(), [["2026-09-01", 21.3], ["2026-09-15", 18.4]]);
  assertEquals(out?.at(-1), { date: dayToEntryDate("2026-09-15"), bodyFat: 18.4 });
  assertEquals(state.legacy.length, 0);
});

function fakeMeasurements(opts: { legacy?: Record<string, unknown>[]; unit?: "cm" | "in"; online?: boolean } = {}) {
  const state = { online: opts.online ?? true, legacy: opts.legacy ?? [] };
  const server = new Map<string, number>(); // "day|site" -> cm
  const guard = () => { if (!state.online) throw new Error("offline"); };
  const db: MeasurementDb = {
    upsert: (rows, { keepExisting }) => {
      guard();
      for (const r of rows) {
        const k = `${r.day}|${r.site}`;
        if (!(keepExisting && server.has(k))) server.set(k, r.cm);
      }
      return Promise.resolve();
    },
    deleteDay: (day) => { guard(); for (const k of [...server.keys()]) if (k.startsWith(`${day}|`)) server.delete(k); return Promise.resolve(); },
    loadRows: () => {
      guard();
      return Promise.resolve([...server].map(([k, value_cm]) => ({ measured_on: k.split("|")[0], site: k.split("|")[1], value_cm })));
    },
  };
  const log = measurementLog({
    userId: `user_${++uid}`,
    unit: opts.unit ?? "cm",
    store: memStore(),
    db,
    legacy: { load: () => Promise.resolve(state.legacy), clear: () => { state.legacy = []; return Promise.resolve(); } },
  });
  return { log, server, state };
}

Deno.test("measurements: a save lands per site in cm on the picked day", async () => {
  const { log, server } = fakeMeasurements({ unit: "in" });
  const out = await log.save("2026-09-15", { waist: 32, bicepL: "14.5", chest: "" });
  await log.flush();
  assertEquals([...server].sort(), [["2026-09-15|bicep_l", 36.83], ["2026-09-15|waist", 81.28]]);
  assertEquals(out?.[0], { id: "2026-09-15", date: dayToEntryDate("2026-09-15"), bicepL: 14.5, waist: 32 });
});

Deno.test("measurements: a second save the same day adds sites, delete clears the day", async () => {
  const { log, server } = fakeMeasurements();
  await log.save("2026-09-15", { waist: 80 });
  await log.flush();
  await log.save("2026-09-15", { chest: 100 });
  await log.flush();
  assertEquals([...server].sort(), [["2026-09-15|chest", 100], ["2026-09-15|waist", 80]]);
  const out = await log.remove("2026-09-15");
  await log.flush();
  assertEquals(server.size, 0);
  assertEquals(out, []);
});

Deno.test("measurements: delete then save offline ends with only the new sites", async () => {
  const { log, server, state } = fakeMeasurements();
  await log.save("2026-09-15", { waist: 80, chest: 100 });
  await log.flush();
  state.online = false;
  await log.remove("2026-09-15");
  await log.save("2026-09-15", { neck: 38 });
  state.online = true;
  await log.flush();
  assertEquals([...server], [["2026-09-15|neck", 38]]);
});

Deno.test("measurements: the old device entries upload once, on the picked day, without overwriting", async () => {
  const { log, server, state } = fakeMeasurements({
    legacy: [
      { id: "b", date: "2026-09-10T00:00:00.000Z", waist: 80, hips: 95 },
      { id: "a", date: "2026-09-01T00:00:00.000Z", waist: 82 },
    ],
  });
  server.set("2026-09-10|hips", 96); // already on the server
  await log.flush();
  assertEquals([...server].sort(), [["2026-09-01|waist", 82], ["2026-09-10|hips", 96], ["2026-09-10|waist", 80]]);
  assertEquals(state.legacy.length, 0);
});

Deno.test("measurements: nothing valid to save is ignored", async () => {
  const { log, server } = fakeMeasurements();
  assertEquals(await log.save("2026-09-15", { waist: 0, chest: "" }), null);
  await log.flush();
  assertEquals(server.size, 0);
});
