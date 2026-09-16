/**
 * Body log rules: weight, body fat and tape measurements, on the server.
 *
 * All three used to live only in AsyncStorage (lib/bodyStats.ts), keyed by the
 * UTC day, with the kg/lbs and cm/in switches acting as labels on whatever
 * number was typed. The server never saw them. Now a signed-in user's entries
 * land in the database in canonical units:
 *   weight       daily_metrics  bodyweight_kg     kg
 *   body fat     daily_metrics  body_fat_percent  %
 *   measurements body_measurements, one row per (day, site), cm
 * The display unit is applied on the way in and out.
 *
 * Every entry is saved on the phone first and uploaded behind it, so nothing is
 * lost offline and no save waits on the network. The old device logs upload
 * once, never over a day the server already has.
 *
 * Pure: no imports, no React, no network. Storage and the database are
 * injected. Unit-tested in bodyLog.test.ts. lib/bodyLogSync.ts binds
 * AsyncStorage and the Supabase client.
 */

export type WeightUnit = 'kg' | 'lbs';
export type LengthUnit = 'cm' | 'in';

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

const round1 = (n: number) => Math.round(n * 10) / 10;
// Stored values keep two decimals: at one, 165 lbs goes in as 74.8 kg and
// comes back as 164.9.
const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Days ────────────────────────────────────────────────────────────────────

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

/**
 * The day an old device entry belongs to, or null when its date is unreadable.
 * Two shapes live here. Weight and body fat entries stored the MOMENT they
 * were typed, so their day is the local day of that moment. The measurements
 * drawer stored a PICKED calendar date as UTC midnight
 * (`new Date('2026-09-15').toISOString()`), and that string's own date is the
 * day the user chose. The exact-midnight test is really the measurement case;
 * it is harmless for the others because a typed moment landing on
 * 00:00:00.000Z to the millisecond does not happen.
 */
export function legacyDayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(iso)) return iso.slice(0, 10);
  return localDayISO(new Date(t));
}

// ─── Units ───────────────────────────────────────────────────────────────────

/** A typed weight in the user's unit, as kg to 0.01. Null when no scale would show it. */
export function toKg(value: number, unit: WeightUnit): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const kg = round2(unit === 'lbs' ? value * KG_PER_LB : value);
  return kg >= 20 && kg <= 400 ? kg : null;
}

/** Stored kg in the user's display unit, to 0.1. */
export function fromKg(kg: number, unit: WeightUnit): number {
  return round1(unit === 'lbs' ? kg / KG_PER_LB : kg);
}

/** A typed body fat percentage to 0.1, or null outside what a person can have. */
export function toBodyFat(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const pct = round1(value);
  return pct >= 2 && pct <= 70 ? pct : null;
}

/** A typed tape measurement in the user's unit, as cm to 0.01. Null outside 5-300 cm. */
export function toCm(value: number, unit: LengthUnit): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const cm = round2(unit === 'in' ? value * CM_PER_IN : value);
  return cm >= 5 && cm <= 300 ? cm : null;
}

/** Stored cm in the user's display unit, to 0.1. */
export function fromCm(cm: number, unit: LengthUnit): number {
  return round1(unit === 'in' ? cm / CM_PER_IN : cm);
}

// The Profile screen's weight and goal fields (user_profiles.weight_kg and
// goal_weight_kg, both kilograms) and the device weight log in lib/bodyStats.ts,
// which guests still keep. The kg/lbs switch used to be a label there too.

/**
 * A stored weight as the text for an input in the user's unit. Empty when
 * nothing is saved. PostgREST can send numeric columns as strings.
 */
export function formatWeight(kg: number | string | null | undefined, unit: WeightUnit): string {
  const n = Number(kg);
  if (kg == null || !Number.isFinite(n) || n <= 0) return '';
  return String(fromKg(n, unit));
}

/**
 * What to save for the text in a weight input. `{ kg: null }` clears the
 * value (the field is empty); `null` means do not save (a half-typed "7" or
 * something that is not a number).
 */
export function parseWeightInput(text: string, unit: WeightUnit): { kg: number | null } | null {
  if (text.trim() === '') return { kg: null };
  const kg = toKg(Number(text.trim().replace(',', '.')), unit);
  return kg == null ? null : { kg };
}

// ─── The device weight log ──────────────────────────────────────────────────
// lib/bodyStats.ts keeps a weight history on the phone (guests, and every user
// until the daily_metrics series lands). Each entry is the number as typed; it
// used to carry no unit, so a switch from lbs to kg read 180 lbs as 180 kg and
// the goal bar showed 92% done for someone who had not moved.

/** A history entry and the unit its number was typed in. */
export interface UnitWeightEntry {
  date: string;
  weight: number;
  unit?: WeightUnit;
}

/**
 * The log with every weight in `unit`. An entry typed in the other unit goes
 * through kilograms at the same rounding as the Profile field, so the history
 * and the field agree (180 lbs shows as 81.7 kg in both). An entry with no unit
 * is taken as already in `unit`; stampLegacyUnits gives old entries one.
 */
export function weightLogInUnit<T extends UnitWeightEntry>(log: T[] | null | undefined, unit: WeightUnit): T[] {
  return (log ?? []).map((e) => {
    if (!e.unit || e.unit === unit) return e;
    const kg = round2(e.unit === 'lbs' ? e.weight * KG_PER_LB : e.weight);
    return { ...e, weight: fromKg(kg, unit), unit };
  });
}

/**
 * Gives entries saved before units were recorded the unit in use now, the best
 * guess available (the log never said). Done once: `changed` tells the caller
 * to save it back, after which a unit switch converts them like any other.
 */
export function stampLegacyUnits<T extends UnitWeightEntry>(
  log: T[] | null | undefined,
  unit: WeightUnit,
): { log: T[]; changed: boolean } {
  if (!Array.isArray(log)) return { log: [], changed: false };
  let changed = false;
  const out = log.map((e) => {
    if (e.unit === 'kg' || e.unit === 'lbs') return e;
    changed = true;
    return { ...e, unit };
  });
  return { log: out, changed };
}

// ─── Day series (weight, body fat) ───────────────────────────────────────────

export interface DayValue {
  day: string;
  value: number;
}
/** `value: null` means "delete that day". */
export interface PendingDayValue {
  day: string;
  value: number | null;
}
/** A daily_metrics row as PostgREST returns it (numeric can arrive as a string). */
export interface DayRow {
  metric_date: string;
  value: number | string;
}
export interface DayPoint {
  date: string;
  value: number;
}

/**
 * An old device log as server rows: one per day (see legacyDayOf), the latest
 * entry of the day wins, unreadable or out-of-range values dropped. Sorted.
 */
export function legacyLogToRows(
  log: { date?: string | null; value?: number | null }[] | null | undefined,
  convert: (typed: number) => number | null,
): DayValue[] {
  const byDay = new Map<string, { at: number; value: number }>();
  for (const e of log ?? []) {
    const day = legacyDayOf(e?.date);
    if (!day) continue;
    const value = convert(Number(e?.value));
    if (value == null) continue;
    const at = new Date(e!.date!).getTime();
    const prev = byDay.get(day);
    if (!prev || at >= prev.at) byDay.set(day, { at, value });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, { value }]) => ({ day, value }));
}

/** Add a pending edit, replacing an earlier pending edit for the same day in place. */
export function withPendingDay(pending: PendingDayValue[], edit: PendingDayValue): PendingDayValue[] {
  const at = pending.findIndex((p) => p.day === edit.day);
  if (at < 0) return [...pending, edit];
  const out = [...pending];
  out[at] = edit;
  return out;
}

/**
 * The series to draw: server rows overlaid by pending edits (an edit wins its
 * day, a pending delete hides it). Oldest first, in the display unit.
 */
export function mergeDaySeries(
  rows: DayRow[] | null | undefined,
  pending: PendingDayValue[] | null | undefined,
  display: (stored: number) => number,
): DayPoint[] {
  const byDay = new Map<string, number>();
  for (const r of rows ?? []) {
    const v = Number(r.value);
    if (r.metric_date && Number.isFinite(v) && v > 0) byDay.set(r.metric_date, v);
  }
  for (const p of pending ?? []) {
    if (p.value == null) byDay.delete(p.day);
    else byDay.set(p.day, p.value);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, v]) => ({ date: dayToEntryDate(day), value: display(v) }));
}

// ─── Measurements ────────────────────────────────────────────────────────────

/** The app's measurement fields (lib/bodyStats.ts MeasurementEntry), in display order. */
export const MEASUREMENT_KEYS = [
  'chest', 'shoulders', 'neck', 'bicepL', 'bicepR', 'forearmL', 'forearmR',
  'waist', 'hips', 'thighL', 'thighR', 'calfL', 'calfR',
] as const;
export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];
export type SiteValues = Partial<Record<MeasurementKey, number>>;

/** App field -> database site: bicepL -> bicep_l. Mirrors the body_measurements.site check. */
export function siteOf(key: MeasurementKey): string {
  return key.replace(/([LR])$/, (s) => `_${s.toLowerCase()}`);
}
const KEY_BY_SITE = new Map<string, MeasurementKey>(MEASUREMENT_KEYS.map((k) => [siteOf(k), k]));
export function keyOfSite(site: string): MeasurementKey | null {
  return KEY_BY_SITE.get(site) ?? null;
}

/** `sites: null` deletes the day. `replace` clears the day's other sites first. */
export interface PendingMeasurement {
  day: string;
  sites: SiteValues | null;
  replace?: boolean;
}
export interface MeasurementRow {
  measured_on: string;
  site: string;
  value_cm: number | string;
}
export interface SiteRow {
  day: string;
  site: string;
  cm: number;
}
export type MeasurementDayOut = { id: string; date: string } & SiteValues;

/** The measurement fields of an entry, typed in `unit`, as cm. Blank or impossible values dropped. */
export function entrySites(entry: Record<string, unknown> | null | undefined, unit: LengthUnit): SiteValues {
  const out: SiteValues = {};
  for (const key of MEASUREMENT_KEYS) {
    const raw = entry?.[key];
    if (raw == null || raw === '') continue;
    const cm = toCm(Number(raw), unit);
    if (cm != null) out[key] = cm;
  }
  return out;
}

/**
 * Old device entries as one cm set per day. Two entries on one day merge; for a
 * site in both, the later entry wins (the device list is newest first).
 */
export function legacyMeasurementsToDays(
  entries: Record<string, unknown>[] | null | undefined,
  unit: LengthUnit,
): { day: string; sites: SiteValues }[] {
  const byDay = new Map<string, SiteValues>();
  for (const e of [...(entries ?? [])].reverse()) {
    const day = legacyDayOf(typeof e?.date === 'string' ? e.date : null);
    if (!day) continue;
    const sites = entrySites(e, unit);
    if (Object.keys(sites).length === 0) continue;
    byDay.set(day, { ...(byDay.get(day) ?? {}), ...sites });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, sites]) => ({ day, sites }));
}

export function sitesToRows(day: string, sites: SiteValues): SiteRow[] {
  return MEASUREMENT_KEYS.filter((k) => sites[k] != null).map((k) => ({ day, site: siteOf(k), cm: sites[k]! }));
}

/**
 * Add a pending measurement edit. Two saves for one day merge their sites; a
 * delete replaces anything pending; a save after a pending delete keeps the
 * delete's effect by replacing the day.
 */
export function withPendingMeasurement(pending: PendingMeasurement[], edit: PendingMeasurement): PendingMeasurement[] {
  const at = pending.findIndex((p) => p.day === edit.day);
  if (at < 0) return [...pending, edit];
  const prev = pending[at];
  let next: PendingMeasurement;
  if (edit.sites == null) next = { day: edit.day, sites: null };
  else if (prev.sites == null) next = { day: edit.day, sites: { ...edit.sites }, replace: true };
  else next = { day: edit.day, sites: { ...prev.sites, ...edit.sites }, replace: !!(prev.replace || edit.replace) };
  const out = [...pending];
  out[at] = next;
  return out;
}

/** Days to draw: server rows overlaid by pending edits. Newest first, in the display unit. */
export function mergeMeasurements(
  rows: MeasurementRow[] | null | undefined,
  pending: PendingMeasurement[] | null | undefined,
  unit: LengthUnit,
): MeasurementDayOut[] {
  const byDay = new Map<string, SiteValues>();
  for (const r of rows ?? []) {
    const key = keyOfSite(r.site);
    const cm = Number(r.value_cm);
    if (!key || !r.measured_on || !Number.isFinite(cm) || cm <= 0) continue;
    byDay.set(r.measured_on, { ...(byDay.get(r.measured_on) ?? {}), [key]: cm });
  }
  for (const p of pending ?? []) {
    if (p.sites == null) byDay.delete(p.day);
    else byDay.set(p.day, { ...(p.replace ? {} : byDay.get(p.day) ?? {}), ...p.sites });
  }
  return [...byDay.entries()]
    .filter(([, sites]) => Object.keys(sites).length > 0)
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, sites]) => {
      const out: MeasurementDayOut = { id: day, date: dayToEntryDate(day) };
      for (const k of MEASUREMENT_KEYS) if (sites[k] != null) out[k] = fromCm(sites[k]!, unit);
      return out;
    });
}

// ─── The upload queue ────────────────────────────────────────────────────────

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** An old device log. Cleared once it is on the server. */
export interface LegacyLog<T> {
  load(): Promise<T[]>;
  clear(): Promise<void>;
}

interface QueueSpec<E extends { day: string }, R, O> {
  /** Storage key part: 'weight', 'bodyfat', 'measurements'. */
  name: string;
  userId: string;
  store: KeyValueStore;
  combine(pending: E[], edit: E): E[];
  /** Write one pending edit. Throws on failure. */
  push(edit: E): Promise<void>;
  /** Upload and clear the old device log. Throws on failure, leaving it in place. */
  uploadLegacy(): Promise<void>;
  loadRows(): Promise<R[]>;
  merge(rows: R[], pending: E[]): O;
}

export interface BodyQueue<E, O> {
  /** Push the old device log and pending edits. Resolves to how many edits still wait. */
  flush(): Promise<number>;
  /** The server (or its last good copy offline) plus pending edits. */
  load(): Promise<O>;
  /** Save an edit on the phone and return the new view at once; the upload follows. */
  edit(edit: E): Promise<O>;
}

// ─── Events and retry with backoff ───────────────────────────────────────────

export type BodyLogEvent =
  | { type: 'edit'; name: string; userId: string }
  | { type: 'flushed'; name: string; userId: string; remaining: number };

const listeners = new Set<(e: BodyLogEvent) => void>();

/** Hear every save and every upload attempt. Returns the unsubscribe. */
export function onBodyLogEvent(listener: (e: BodyLogEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(e: BodyLogEvent) {
  for (const l of listeners) {
    try { l(e); } catch { /* a listener must never break a save */ }
  }
}

/** An upload error that retrying can never fix (the server rejected the data itself). */
export function isPermanentError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { permanent?: unknown }).permanent === true;
}

/** Gap before retry number `attempt` (0-based): 15 s, 30 s, 60 s ... capped at 15 min. */
export function retryDelayMs(attempt: number, baseMs = 15_000, maxMs = 900_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
}

export interface RetryScheduler {
  /** An upload round for one log finished with `remaining` entries still waiting. */
  flushed(name: string, remaining: number): void;
  /** A new save: start the backoff over. */
  reset(): void;
  /** App went to the background: cancel and ignore results until resume. */
  pause(): void;
  resume(): void;
}

/**
 * Retries uploads while any log still has entries waiting, with a gap that
 * doubles each round (a long outage costs a handful of requests, not one every
 * few seconds). Success on every log stops it; a save or a return to the app
 * starts it over at the shortest gap. Timers are injected for tests.
 */
export function createRetryScheduler(o: {
  run: () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  baseMs?: number;
  maxMs?: number;
}): RetryScheduler {
  const waiting = new Map<string, number>();
  let attempt = 0;
  let timer: unknown = null;
  let paused = false;
  const cancel = () => {
    if (timer != null) o.clearTimer(timer);
    timer = null;
  };
  return {
    flushed(name, remaining) {
      waiting.set(name, remaining);
      if (paused) return;
      const total = [...waiting.values()].reduce((a, b) => a + b, 0);
      if (total === 0) {
        cancel();
        attempt = 0;
        return;
      }
      if (timer != null) return; // this round already has its retry
      timer = o.setTimer(() => {
        timer = null;
        o.run();
      }, retryDelayMs(attempt, o.baseMs, o.maxMs));
      attempt++;
    },
    reset() {
      cancel();
      attempt = 0;
    },
    pause() {
      paused = true;
      cancel();
    },
    resume() {
      paused = false;
      attempt = 0;
    },
  };
}

// Per-key serial queues. Storage reads and writes are separate awaits, so two
// read-modify-write passes that interleave lose an edit: an upload finishing
// while a new entry was saved wrote back its stale copy of the list and erased
// the new one. Every change to a pending list goes through one queue; flushes
// go through another, so an edit made mid-flush is picked up by the flush
// queued behind it.
const queues = new Map<string, Promise<unknown>>();
function serially<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next.catch(() => {}));
  return next;
}

async function readJson<T>(store: KeyValueStore, key: string, fallback: T): Promise<T> {
  try {
    const raw = await store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function bodyQueue<E extends { day: string }, R, O>(s: QueueSpec<E, R, O>): BodyQueue<E, O> {
  const pendingKey = `overload_${s.name}_pending_v1::${s.userId}`;
  const seriesKey = `overload_${s.name}_series_v1::${s.userId}`;
  const readPending = () => readJson<E[]>(s.store, pendingKey, []);
  const mutate = (change: (p: E[]) => E[]) =>
    serially(`${s.name}:pending:${s.userId}`, async () => {
      const next = change(await readPending());
      await s.store.setItem(pendingKey, JSON.stringify(next));
      return next;
    });

  const flush = () =>
    serially(`${s.name}:flush:${s.userId}`, async () => {
      try {
        await s.uploadLegacy();
      } catch {
        // Offline or refused: the device log stays, the next flush retries.
      }
      for (const p of await readPending()) {
        try {
          await s.push(p);
        } catch (e) {
          // The server rejected the data itself: retrying never helps, and a
          // stuck entry would block every entry behind it. Drop it.
          // Anything else (offline, auth, a missing table) keeps it and stops,
          // so a later edit never lands before an earlier one.
          if (!isPermanentError(e)) break;
        }
        // Drop it only if the user did not edit this day again while the write ran.
        const sent = JSON.stringify(p);
        await mutate((now) => now.filter((x) => !(x.day === p.day && JSON.stringify(x) === sent)));
      }
      const remaining = (await readPending()).length;
      emit({ type: 'flushed', name: s.name, userId: s.userId, remaining });
      return remaining;
    });

  const cached = () => readJson<R[]>(s.store, seriesKey, []);

  return {
    flush,
    async load() {
      await flush().catch(() => 0);
      let rows: R[];
      try {
        rows = await s.loadRows();
        await s.store.setItem(seriesKey, JSON.stringify(rows));
      } catch {
        rows = await cached();
      }
      return s.merge(rows, await readPending());
    },
    async edit(edit) {
      // Never wait on the network here: callers flash "Logged" when this resolves.
      const pending = await mutate((now) => s.combine(now, edit));
      emit({ type: 'edit', name: s.name, userId: s.userId });
      flush().catch(() => 0);
      return s.merge(await cached(), pending);
    },
  };
}

// ─── The three logs ──────────────────────────────────────────────────────────

/** The server side of a day series, already scoped to one user and one metric. */
export interface DayValueDb {
  /** keepExisting: true inserts only days the server does not have yet. */
  upsert(rows: DayValue[], opts: { keepExisting: boolean }): Promise<void>;
  deleteDay(day: string): Promise<void>;
  loadRows(): Promise<DayRow[]>;
}

export interface DaySeriesLog<Out> {
  flush(): Promise<number>;
  load(): Promise<Out[]>;
  /** Log a typed value for the local day of `now`; a later one that day replaces it. Null when not a value. */
  log(typed: number, now?: Date): Promise<Out[] | null>;
  remove(day: string): Promise<Out[]>;
}

function daySeriesLog<Out>(d: {
  name: string;
  userId: string;
  store: KeyValueStore;
  db: DayValueDb;
  legacy: LegacyLog<{ date?: string | null; value?: number | null }>;
  toStored: (typed: number) => number | null;
  /** How an old device entry's value becomes a stored one. Defaults to toStored. */
  legacyToStored?: (value: number) => number | null;
  display: (stored: number) => number;
  out: (p: DayPoint) => Out;
}): DaySeriesLog<Out> {
  const q = bodyQueue<PendingDayValue, DayRow, Out[]>({
    name: d.name,
    userId: d.userId,
    store: d.store,
    combine: withPendingDay,
    push: (p) => (p.value == null ? d.db.deleteDay(p.day) : d.db.upsert([{ day: p.day, value: p.value }], { keepExisting: false })),
    async uploadLegacy() {
      const rows = legacyLogToRows(await d.legacy.load(), d.legacyToStored ?? d.toStored);
      if (rows.length > 0) await d.db.upsert(rows, { keepExisting: true });
      await d.legacy.clear();
    },
    loadRows: () => d.db.loadRows(),
    merge: (rows, pending) => mergeDaySeries(rows, pending, d.display).map(d.out),
  });
  return {
    flush: q.flush,
    load: q.load,
    async log(typed, now = new Date()) {
      const value = d.toStored(typed);
      if (value == null) return null;
      return q.edit({ day: localDayISO(now), value });
    },
    remove: (day) => q.edit({ day, value: null }),
  };
}

export function weightLog(d: {
  userId: string;
  unit: WeightUnit;
  store: KeyValueStore;
  db: DayValueDb;
  /** `unit`: the unit an entry was typed in, when the device log recorded it. */
  legacy: LegacyLog<{ date?: string | null; weight?: number | null; unit?: WeightUnit | null }>;
}): DaySeriesLog<{ date: string; weight: number }> {
  return daySeriesLog({
    name: 'weight',
    userId: d.userId,
    store: d.store,
    db: d.db,
    // Each old entry converts in its own unit when it has one, else the saved
    // unit: a guest who logged in kg and later switched to lbs must not upload
    // kg numbers read as lbs.
    legacy: {
      load: async () => (await d.legacy.load()).map((e) => ({
        date: e?.date,
        value: toKg(Number(e?.weight), e?.unit === 'kg' || e?.unit === 'lbs' ? e.unit : d.unit),
      })),
      clear: d.legacy.clear,
    },
    legacyToStored: (kg) => toKg(kg, 'kg'),
    toStored: (v) => toKg(v, d.unit),
    display: (kg) => fromKg(kg, d.unit),
    out: (p) => ({ date: p.date, weight: p.value }),
  });
}

export function bodyFatLog(d: {
  userId: string;
  store: KeyValueStore;
  db: DayValueDb;
  legacy: LegacyLog<{ date?: string | null; bodyFat?: number | null }>;
}): DaySeriesLog<{ date: string; bodyFat: number }> {
  return daySeriesLog({
    name: 'bodyfat',
    userId: d.userId,
    store: d.store,
    db: d.db,
    legacy: { load: async () => (await d.legacy.load()).map((e) => ({ date: e?.date, value: e?.bodyFat })), clear: d.legacy.clear },
    toStored: toBodyFat,
    display: (pct) => pct,
    out: (p) => ({ date: p.date, bodyFat: p.value }),
  });
}

/** The server side of body_measurements, already scoped to one user. */
export interface MeasurementDb {
  upsert(rows: SiteRow[], opts: { keepExisting: boolean }): Promise<void>;
  /** Clears the day. `keepSites` leaves those sites in place. */
  deleteDay(day: string, keepSites?: string[]): Promise<void>;
  loadRows(): Promise<MeasurementRow[]>;
}

export interface MeasurementLog {
  flush(): Promise<number>;
  load(): Promise<MeasurementDayOut[]>;
  /** Save the typed fields for a day, merging with that day's other sites. Null when nothing valid. */
  save(day: string, typed: Record<string, unknown>): Promise<MeasurementDayOut[] | null>;
  remove(day: string): Promise<MeasurementDayOut[]>;
}

export function measurementLog(d: {
  userId: string;
  unit: LengthUnit;
  store: KeyValueStore;
  db: MeasurementDb;
  legacy: LegacyLog<Record<string, unknown>>;
}): MeasurementLog {
  const q = bodyQueue<PendingMeasurement, MeasurementRow, MeasurementDayOut[]>({
    name: 'measurements',
    userId: d.userId,
    store: d.store,
    combine: withPendingMeasurement,
    async push(p) {
      if (p.sites == null) {
        await d.db.deleteDay(p.day);
        return;
      }
      // Write the new sites FIRST, then clear the day's others. Clearing first
      // would lose sites the server already had if the write then failed for
      // good (a permanent failure drops the entry, so nothing would fix it).
      const rows = sitesToRows(p.day, p.sites);
      if (rows.length > 0) await d.db.upsert(rows, { keepExisting: false });
      if (p.replace) await d.db.deleteDay(p.day, rows.map((r) => r.site));
    },
    async uploadLegacy() {
      const days = legacyMeasurementsToDays(await d.legacy.load(), d.unit);
      const rows = days.flatMap((x) => sitesToRows(x.day, x.sites));
      if (rows.length > 0) await d.db.upsert(rows, { keepExisting: true });
      await d.legacy.clear();
    },
    loadRows: () => d.db.loadRows(),
    merge: (rows, pending) => mergeMeasurements(rows, pending, d.unit),
  });
  return {
    flush: q.flush,
    load: q.load,
    async save(day, typed) {
      const sites = entrySites(typed, d.unit);
      if (Object.keys(sites).length === 0) return null;
      return q.edit({ day, sites });
    },
    remove: (day) => q.edit({ day, sites: null }),
  };
}
