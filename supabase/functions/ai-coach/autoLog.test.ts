// Run with: deno test --allow-all supabase/functions/ai-coach/autoLog.test.ts
//
// "Just log it" (plan B1): the server writes the diary itself. What has to hold:
// lines land in the section the parser named, a doubtful meal never auto-logs,
// a retried send is a no-op, and the client hanging up does NOT abort the parse
// in this mode (while review mode keeps aborting).

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  type AutoLogEntryRow,
  type AutoLogStore,
  autoLogBlocker,
  dayWindow,
  groupIntoSections,
  parseAbortFor,
  readAutoLogRequest,
  sectionClientId,
  sectionClientIds,
  writeAutoLog,
} from "./autoLog.ts";
import type { MealType, ParsedItem } from "./parseMeal.ts";

const line = (food_name: string, extra: Partial<ParsedItem> = {}): ParsedItem => ({
  food_id: null, food_name, quantity: 1, serving_label: "serving", grams: 100,
  kcal: 100, protein_g: 5, carb_g: 10, fat_g: 3, fiber_g: null,
  source: "estimate", assumption: null, confidence: "medium", ...extra,
});

const CID = "0f2c9a1e-3b4d-4c5e-8f6a-7b8c9d0e1f2a";

// ── Request reading ──────────────────────────────────────────────────────────

Deno.test("auto_log is honoured only with a uuid client_id", () => {
  assertEquals(readAutoLogRequest({ auto_log: true, client_id: CID }, "2026-09-05").autoLog, true);
  assertEquals(readAutoLogRequest({ auto_log: true, client_id: "not-a-uuid" }, null).autoLog, false);
  assertEquals(readAutoLogRequest({ auto_log: true }, null).autoLog, false);
  assertEquals(readAutoLogRequest({ auto_log: "true", client_id: CID }, null).autoLog, false);
});

Deno.test("log_date wins over local_date; a garbage offset reads as UTC", () => {
  const r = readAutoLogRequest(
    { auto_log: true, client_id: CID, log_date: "2026-09-04", tz_offset_min: -330 },
    "2026-09-05",
  );
  assertEquals(r.logDate, "2026-09-04");
  assertEquals(r.tzOffsetMin, -330);
  const bad = readAutoLogRequest({ client_id: CID, log_date: "yesterday", tz_offset_min: "x" }, "2026-09-05");
  assertEquals(bad.logDate, "2026-09-05");
  assertEquals(bad.tzOffsetMin, 0);
});

// ── Grouping ─────────────────────────────────────────────────────────────────

Deno.test("grouping: lines land in the section stamped on them, first-seen order", () => {
  const out = groupIntoSections(
    [
      line("eggs", { meal_type: "breakfast" }),
      line("dal", { meal_type: "lunch" }),
      line("toast", { meal_type: "breakfast" }),
      line("oreos"), // no stamp: the fallback
    ],
    "snack",
  );
  assertEquals(out.map((s) => s.meal_type), ["breakfast", "lunch", "snack"]);
  assertEquals(out[0].items.map((i) => i.food_name), ["eggs", "toast"]);
  assertEquals(out[1].items.map((i) => i.food_name), ["dal"]);
  assertEquals(out[2].items.map((i) => i.food_name), ["oreos"]);
});

// ── The implausible valve ────────────────────────────────────────────────────

Deno.test("an ordinary meal passes the valve", () => {
  assertEquals(autoLogBlocker([line("chicken breast", { protein_g: 62, kcal: 330 })]), null);
});

Deno.test("one line over the protein flag blocks the whole meal", () => {
  const reason = autoLogBlocker([line("latte"), line("latte", { protein_g: 163 })]);
  assert(reason !== null);
  assert(reason.includes("163"));
});

Deno.test("one line over the calorie flag blocks the whole meal", () => {
  assert(autoLogBlocker([line("biryani", { kcal: 2400 })]) !== null);
});

// ── Section ids ──────────────────────────────────────────────────────────────

Deno.test("section ids: one per meal type, all distinct, all still uuids", () => {
  const ids = sectionClientIds(CID);
  assertEquals(new Set(ids).size, 4);
  for (const id of ids) assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
  assertEquals(sectionClientId(CID.toUpperCase(), "lunch"), sectionClientId(CID, "lunch"));
});

// ── Day window ───────────────────────────────────────────────────────────────

Deno.test("day window: IST day maps to the right UTC span, today keeps the real time", () => {
  // 2026-09-05 in IST (UTC+5:30) starts at 2026-09-04T18:30Z.
  const noonIst = Date.UTC(2026, 8, 5, 6, 30);
  const w = dayWindow("2026-09-05", -330, noonIst);
  assertEquals(w.start, "2026-09-04T18:30:00.000Z");
  assertEquals(w.end, "2026-09-05T18:29:59.999Z");
  assertEquals(w.loggedAt, new Date(noonIst).toISOString());
  // A past day lands at local noon, inside its own window.
  const past = dayWindow("2026-09-03", -330, noonIst);
  assertEquals(past.loggedAt, "2026-09-03T06:30:00.000Z");
  assert(past.loggedAt > past.start && past.loggedAt < past.end);
});

// ── The abort policy ─────────────────────────────────────────────────────────

Deno.test("review mode: the stream's cancel() aborts the parse", () => {
  const { signal, cancel } = parseAbortFor(false);
  cancel();
  assertEquals(signal.aborted, true);
});

Deno.test("auto_log: the stream's cancel() does NOT abort the parse", () => {
  const { signal, cancel } = parseAbortFor(true);
  cancel();
  assertEquals(signal.aborted, false);
});

// ── The write, against a fake store ──────────────────────────────────────────

interface MealRow { id: string; meal_type: MealType; logged_at: string; client_id: string | null }

class FakeStore implements AutoLogStore {
  meals: MealRow[] = [];
  entries: (AutoLogEntryRow & { id: string })[] = [];
  calls: string[] = [];
  failInsert = false;
  private seq = 0;
  private nextId(prefix: string) { return `${prefix}-${++this.seq}`; }

  entriesByClientId(clientId: string) {
    this.calls.push("entriesByClientId");
    return Promise.resolve(this.entries.filter((e) => e.client_id === clientId).map((e) => ({ id: e.id, meal_id: e.meal_id })));
  }
  mealsById(ids: string[]) {
    return Promise.resolve(this.meals.filter((m) => ids.includes(m.id)).map((m) => ({ id: m.id, meal_type: m.meal_type, client_id: m.client_id })));
  }
  findMeal(mealType: MealType, start: string, end: string) {
    this.calls.push(`findMeal:${mealType}`);
    const m = this.meals.find((r) => r.meal_type === mealType && r.logged_at >= start && r.logged_at <= end);
    return Promise.resolve(m?.id ?? null);
  }
  createMeal(row: { meal_type: MealType; logged_at: string; client_id: string }) {
    this.calls.push(`createMeal:${row.meal_type}`);
    if (this.meals.some((m) => m.client_id === row.client_id)) return Promise.resolve({ conflict: true as const });
    const id = this.nextId("meal");
    this.meals.push({ id, ...row });
    return Promise.resolve({ id });
  }
  mealByClientId(clientId: string) {
    return Promise.resolve(this.meals.find((m) => m.client_id === clientId)?.id ?? null);
  }
  countEntries(mealId: string) {
    return Promise.resolve(this.entries.filter((e) => e.meal_id === mealId).length);
  }
  insertEntries(rows: AutoLogEntryRow[]) {
    this.calls.push(`insertEntries:${rows.length}`);
    if (this.failInsert) return Promise.resolve({ error: "boom" });
    const ids = rows.map((r) => {
      const id = this.nextId("entry");
      this.entries.push({ ...r, id });
      return id;
    });
    return Promise.resolve({ ids });
  }
  deleteEntries(ids: string[]) {
    this.calls.push(`deleteEntries:${ids.length}`);
    this.entries = this.entries.filter((e) => !ids.includes(e.id));
    return Promise.resolve();
  }
  deleteMealIfEmpty(mealId: string) {
    this.calls.push(`deleteMealIfEmpty`);
    if (!this.entries.some((e) => e.meal_id === mealId)) this.meals = this.meals.filter((m) => m.id !== mealId);
    return Promise.resolve();
  }
}

const NOW = Date.UTC(2026, 8, 5, 6, 30); // IST noon on 2026-09-05
const writeArgs = (items: ParsedItem[]) => ({
  clientId: CID, items, fallbackMeal: "snack" as MealType, logDate: "2026-09-05", tzOffsetMin: -330, nowMs: NOW,
});

Deno.test("write: a two-section message creates two meals and stamps every entry", async () => {
  const store = new FakeStore();
  const res = await writeAutoLog(store, writeArgs([
    line("eggs", { meal_type: "breakfast" }),
    line("dal", { meal_type: "lunch" }),
    line("rice", { meal_type: "lunch", source: "catalog", food_id: "f1" }),
  ]));
  assert("logged" in res);
  assertEquals(res.replayed, false);
  assertEquals(res.logged.sections.map((s) => s.meal_type), ["breakfast", "lunch"]);
  assertEquals(res.logged.sections.map((s) => s.entry_ids.length), [1, 2]);
  assert(res.logged.sections.every((s) => s.created_meal));
  // Created meals carry DISTINCT derived ids (the unique index allows one row per id).
  const mealIds = store.meals.map((m) => m.client_id);
  assertEquals(new Set(mealIds).size, 2);
  assertNotEquals(mealIds[0], CID);
  // Every entry carries the send's raw id plus the auto marker.
  assert(store.entries.every((e) => e.client_id === CID && e.logged_via === "ai_auto"));
  assertEquals(store.entries.map((e) => e.position), [0, 0, 1]);
  assertEquals(store.entries[2].source, "catalog");
});

Deno.test("write: an existing section meal is reused, not duplicated", async () => {
  const store = new FakeStore();
  store.meals.push({ id: "lunch-existing", meal_type: "lunch", logged_at: "2026-09-05T02:00:00.000Z", client_id: null });
  // Something the user logged earlier by hand: no client_id of its own.
  store.entries.push({ ...rowFor("lunch-existing", "earlier"), id: "e-old", client_id: "" });
  const res = await writeAutoLog(store, writeArgs([line("dal", { meal_type: "lunch" })]));
  assert("logged" in res);
  assertEquals(res.logged.sections[0].meal_id, "lunch-existing");
  assertEquals(res.logged.sections[0].created_meal, false);
  assertEquals(store.meals.length, 1);
  // Position continues after what was already there.
  assertEquals(store.entries.at(-1)?.position, 1);
});

Deno.test("idempotent retry: the same send twice writes once and replays the first", async () => {
  const store = new FakeStore();
  const items = [line("eggs", { meal_type: "breakfast" }), line("dal", { meal_type: "lunch" })];
  const first = await writeAutoLog(store, writeArgs(items));
  const second = await writeAutoLog(store, writeArgs(items));
  assert("logged" in first && "logged" in second);
  assertEquals(second.replayed, true);
  assertEquals(store.entries.length, 2);
  assertEquals(store.meals.length, 2);
  const key = (s: { meal_type: string; meal_id: string; entry_ids: string[] }) => `${s.meal_type}:${s.meal_id}:${s.entry_ids.join(",")}`;
  assertEquals(second.logged.sections.map(key).sort(), first.logged.sections.map(key).sort());
  assert(second.logged.sections.every((s) => s.created_meal));
  // One insert per section on the first write; the retry never reached the write path.
  assertEquals(store.calls.filter((c) => c.startsWith("insertEntries")).length, 2);
});

Deno.test("idempotent retry into a pre-existing meal: still writes once", async () => {
  const store = new FakeStore();
  store.meals.push({ id: "lunch-existing", meal_type: "lunch", logged_at: "2026-09-05T02:00:00.000Z", client_id: null });
  const items = [line("dal", { meal_type: "lunch" })];
  await writeAutoLog(store, writeArgs(items));
  const second = await writeAutoLog(store, writeArgs(items));
  assert("logged" in second && second.replayed);
  assertEquals(store.entries.length, 1);
  assertEquals(second.logged.sections[0].created_meal, false);
});

Deno.test("concurrent duplicate: a unique-index conflict recovers the winner's rows", async () => {
  const store = new FakeStore();
  // The "other" attempt already created breakfast with the derived id and
  // wrote its entry, but our pre-check ran before that landed: simulate by
  // pre-seeding the meal and entry, then bypassing the pre-check via a store
  // whose first entriesByClientId answers empty.
  const sid = sectionClientId(CID, "breakfast");
  store.meals.push({ id: "their-meal", meal_type: "breakfast", logged_at: "2026-09-05T01:00:00.000Z", client_id: sid });
  store.entries.push({ ...rowFor("their-meal", "eggs"), id: "their-entry" });
  let first = true;
  const orig = store.entriesByClientId.bind(store);
  store.entriesByClientId = (cid) => {
    if (first) { first = false; return Promise.resolve([]); }
    return orig(cid);
  };
  // findMeal must miss so we go down the create path and hit the index.
  store.findMeal = () => Promise.resolve(null);
  const res = await writeAutoLog(store, writeArgs([line("eggs", { meal_type: "breakfast" })]));
  assert("logged" in res && res.replayed);
  assertEquals(res.logged.sections[0].entry_ids, ["their-entry"]);
  assertEquals(store.entries.length, 1);
});

Deno.test("write error part-way undoes the sections that already landed", async () => {
  const store = new FakeStore();
  let inserts = 0;
  const origInsert = store.insertEntries.bind(store);
  store.insertEntries = (rows) => {
    inserts++;
    if (inserts === 2) return Promise.resolve({ error: "second section failed" });
    return origInsert(rows);
  };
  const res = await writeAutoLog(store, writeArgs([
    line("eggs", { meal_type: "breakfast" }),
    line("dal", { meal_type: "lunch" }),
  ]));
  assert("error" in res);
  assertEquals(store.entries.length, 0);
  assertEquals(store.meals.length, 0);
});

function rowFor(mealId: string, name: string): AutoLogEntryRow {
  return {
    meal_id: mealId, food_id: null, food_name: name, quantity: 1, serving_unit: "serving",
    grams_logged: 100, kcal: 100, protein_g: 5, carb_g: 10, fat_g: 3, fiber_g: null,
    sugar_g: null, sat_fat_g: null, sodium_mg: null, position: 0, logged_via: "ai_auto",
    source: "estimate", client_id: CID,
  };
}
