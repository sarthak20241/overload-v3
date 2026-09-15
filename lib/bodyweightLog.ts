/**
 * Bodyweight log rules: the local day, real kilograms, and how pending edits
 * merge with the server series.
 *
 * Manual weight used to live only in AsyncStorage (lib/bodyStats.ts), keyed by
 * the UTC day, with the kg/lbs switch acting as a label on whatever number was
 * typed. The server never saw it. Now a signed-in user's weigh-ins land in
 * daily_metrics (bodyweight_kg, source 'manual') next to the HealthKit and
 * Health Connect readings. The server always holds kilograms; the display unit
 * is applied on the way in and out.
 *
 * Pure: no imports, no React, no network. Unit-tested in bodyweightLog.test.ts.
 * The I/O lives in lib/bodyweightSync.ts.
 */

export type WeightUnit = 'kg' | 'lbs';

export const KG_PER_LB = 0.45359237;

/** Outside this range the value is a half-typed number or a slip, not a weigh-in. */
const MIN_KG = 20;
const MAX_KG = 400;

/** One day's weight. `kg: null` in a pending edit means "delete that day". */
export interface DayWeight {
  day: string; // YYYY-MM-DD, local
  kg: number;
}
export interface PendingWeight {
  day: string;
  kg: number | null;
}

/** A daily_metrics row as PostgREST returns it (numeric can arrive as a string). */
export interface WeightRow {
  metric_date: string;
  value: number | string;
}

/** What the Profile and Analytics screens draw: a timestamp and a display-unit weight. */
export interface WeightEntryOut {
  date: string;
  weight: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
// Stored kg keep two decimals: at one, 165 lbs goes in as 74.8 kg and comes back as 164.9.
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The local calendar day of a moment, as YYYY-MM-DD. Never the UTC day. */
export function localDayISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local noon of a day, as an ISO string. Noon so no zone or DST shift moves it. */
export function dayToEntryDate(day: string): string {
  const [y, m, d] = day.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d, 12).toISOString();
}

/** A typed value in the user's unit, as kilograms to 0.01. Null when no scale would show it. */
export function toKg(value: number, unit: WeightUnit): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const kg = round2(unit === 'lbs' ? value * KG_PER_LB : value);
  return kg >= MIN_KG && kg <= MAX_KG ? kg : null;
}

/** Stored kilograms in the user's display unit, to 0.1. */
export function fromKg(kg: number, unit: WeightUnit): number {
  return round1(unit === 'lbs' ? kg / KG_PER_LB : kg);
}

/**
 * The old device log as server rows: one per LOCAL day, the latest entry of the
 * day wins, unreadable or out-of-range entries dropped. `unit` is the unit the
 * numbers were typed in (the log never recorded it; the current one is the
 * best guess). Sorted by day.
 */
export function legacyLogToRows(
  log: { date?: string | null; weight?: number | null }[] | null | undefined,
  unit: WeightUnit,
): DayWeight[] {
  const byDay = new Map<string, { at: number; kg: number }>();
  for (const e of log ?? []) {
    const at = new Date(e?.date ?? '').getTime();
    if (!Number.isFinite(at)) continue;
    const kg = toKg(Number(e?.weight), unit);
    if (kg == null) continue;
    const day = localDayISO(new Date(at));
    const prev = byDay.get(day);
    if (!prev || at >= prev.at) byDay.set(day, { at, kg });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, { kg }]) => ({ day, kg }));
}

/** Add a pending edit, replacing any earlier pending edit for the same day. */
export function withPending(pending: PendingWeight[], edit: PendingWeight): PendingWeight[] {
  const rest = pending.filter((p) => p.day !== edit.day);
  const at = pending.findIndex((p) => p.day === edit.day);
  if (at < 0) return [...rest, edit];
  const out = [...pending];
  out[at] = edit;
  return out;
}

/**
 * The series to draw: server rows, overlaid by pending edits that have not
 * reached the server yet (an edit wins its day, a pending delete hides it).
 * Oldest first, weights in the display unit.
 */
export function mergeSeries(
  rows: WeightRow[] | null | undefined,
  pending: PendingWeight[] | null | undefined,
  unit: WeightUnit,
): WeightEntryOut[] {
  const byDay = new Map<string, number>();
  for (const r of rows ?? []) {
    const v = Number(r.value);
    if (r.metric_date && Number.isFinite(v) && v > 0) byDay.set(r.metric_date, v);
  }
  for (const p of pending ?? []) {
    if (p.kg == null) byDay.delete(p.day);
    else byDay.set(p.day, p.kg);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, kg]) => ({ date: dayToEntryDate(day), weight: fromKg(kg, unit) }));
}

// ─── Sync core ───────────────────────────────────────────────────────────────
// Storage and the database are injected so this stays import-free and
// testable. lib/bodyweightSync.ts binds AsyncStorage and the Supabase client.

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** The server side, already scoped to one user. Every method throws on failure. */
export interface WeightDb {
  /** keepExisting: true inserts only days the server does not have yet. */
  upsert(rows: DayWeight[], opts: { keepExisting: boolean }): Promise<void>;
  deleteDay(day: string): Promise<void>;
  loadRows(): Promise<WeightRow[]>;
}

/** The pre-server device log (lib/bodyStats.ts). Cleared once it is on the server. */
export interface LegacyWeightLog {
  load(): Promise<{ date?: string | null; weight?: number | null }[]>;
  clear(): Promise<void>;
}

export interface WeightDeps {
  userId: string;
  unit: WeightUnit;
  store: KeyValueStore;
  db: WeightDb;
  legacy: LegacyWeightLog;
}

const pendingKey = (userId: string) => `overload_weight_pending_v1::${userId}`;
const seriesKey = (userId: string) => `overload_weight_series_v1::${userId}`;

async function readJson<T>(store: KeyValueStore, key: string, fallback: T): Promise<T> {
  try {
    const raw = await store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const readPending = (d: WeightDeps) => readJson<PendingWeight[]>(d.store, pendingKey(d.userId), []);

// Per-key serial queues. Storage reads and writes are separate awaits, so two
// read-modify-write passes that interleave lose an edit: an upload finishing
// while a new weigh-in is saved wrote back its stale copy of the list and
// erased the new one. Every change to the pending list goes through one queue;
// flushes go through another, so an edit made mid-flush is picked up by the
// flush queued behind it.
const queues = new Map<string, Promise<unknown>>();
function serially<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next.catch(() => {}));
  return next;
}

function mutatePending(d: WeightDeps, change: (pending: PendingWeight[]) => PendingWeight[]): Promise<PendingWeight[]> {
  return serially(`pending:${d.userId}`, async () => {
    const next = change(await readPending(d));
    await d.store.setItem(pendingKey(d.userId), JSON.stringify(next));
    return next;
  });
}

/**
 * Push everything this device holds that the server does not: first the old
 * device log (once, and never over a day the server already has), then pending
 * edits in order. A failed step leaves its data in place for the next flush.
 * Returns how many pending edits are still waiting.
 */
export function flushWeights(d: WeightDeps): Promise<number> {
  const run = async (): Promise<number> => {
    try {
      const rows = legacyLogToRows(await d.legacy.load(), d.unit);
      if (rows.length > 0) await d.db.upsert(rows, { keepExisting: true });
      await d.legacy.clear();
    } catch {
      // Offline or refused: the device log stays, the next flush retries.
    }

    for (const p of await readPending(d)) {
      try {
        if (p.kg == null) await d.db.deleteDay(p.day);
        else await d.db.upsert([{ day: p.day, kg: p.kg }], { keepExisting: false });
      } catch {
        break; // keep order: a later edit must not land before an earlier one
      }
      // Drop it only if the user did not edit this day again while the write ran.
      await mutatePending(d, (now) => {
        const still = now.find((x) => x.day === p.day);
        return still && still.kg === p.kg ? now.filter((x) => x.day !== p.day) : now;
      });
    }
    return (await readPending(d)).length;
  };
  return serially(`flush:${d.userId}`, run);
}

/** The series to draw: the server (or its last good copy offline) plus pending edits. */
export async function loadWeights(d: WeightDeps): Promise<WeightEntryOut[]> {
  await flushWeights(d).catch(() => {});
  let rows: WeightRow[];
  try {
    rows = await d.db.loadRows();
    await d.store.setItem(seriesKey(d.userId), JSON.stringify(rows));
  } catch {
    rows = await readJson<WeightRow[]>(d.store, seriesKey(d.userId), []);
  }
  return mergeSeries(rows, await readPending(d), d.unit);
}

// Saves on the device and returns at once; the upload runs behind it. Never
// wait on the network here: the caller flashes "Logged" when this resolves.
async function edit(d: WeightDeps, change: PendingWeight): Promise<WeightEntryOut[]> {
  const pending = await mutatePending(d, (now) => withPending(now, change));
  flushWeights(d).catch(() => {});
  const cached = await readJson<WeightRow[]>(d.store, seriesKey(d.userId), []);
  return mergeSeries(cached, pending, d.unit);
}

/**
 * Log a weigh-in for the local day of `now` (one per day, a later one replaces
 * it). `value` is in the user's unit. Saved on the device and returned at once,
 * so it is never lost offline; the server write follows in the background.
 * Returns the new series, or null when the value is not a weight.
 */
export async function logWeight(d: WeightDeps, value: number, now: Date = new Date()): Promise<WeightEntryOut[] | null> {
  const kg = toKg(value, d.unit);
  if (kg == null) return null;
  return edit(d, { day: localDayISO(now), kg });
}

/** Remove a day's weight. A hub reading for that day can come back on the next health sync. */
export function deleteWeight(d: WeightDeps, day: string): Promise<WeightEntryOut[]> {
  return edit(d, { day, kg: null });
}
