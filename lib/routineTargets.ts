/**
 * Time and distance targets for a routine slot.
 *
 * routine_exercises.target_duration_seconds / target_distance_m (migration
 * 20261016140000). A rep-based slot leaves both NULL. A slot whose exercise is
 * measured by time or distance (exercises.metric_type) can carry one, and the
 * workout screen prefills the logger from it.
 *
 * The app ships before the migration, so every reader here fails open: a row
 * from a database without the columns simply has no target.
 */
import { metricTypeDef } from './exercises';
import { formatDistanceKm, formatDuration, parseDistanceKm, parseDuration } from './format';

export interface RoutineTargets {
  target_duration_seconds: number | null;
  target_distance_m: number | null;
}

/** Does this metric type log a time per set (duration, duration_weight,
 *  distance_duration, resistance_duration)? */
export function takesDurationTarget(metricType: string | null | undefined): boolean {
  return metricTypeDef(metricType).axes.includes('duration');
}

/** Does this metric type log a distance per set (distance_duration, weight_distance)? */
export function takesDistanceTarget(metricType: string | null | undefined): boolean {
  return metricTypeDef(metricType).axes.includes('distance');
}

function positive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The targets on a routine_exercises row as read back from the server, the
 * local cache, or the guest store. Missing keys (an older database, an older
 * cached row) and junk both read as "no target". target_distance_m is a
 * numeric column, which PostgREST may hand back as a string.
 */
export function readRoutineTargets(row: unknown): RoutineTargets {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  const secs = positive(r.target_duration_seconds);
  return {
    target_duration_seconds: secs == null ? null : Math.round(secs),
    target_distance_m: positive(r.target_distance_m),
  };
}

const UNIT_SECONDS: Record<string, number> = { s: 1, min: 60, h: 3600 };
const UNIT_METERS: Record<string, number> = { m: 1, km: 1000, mi: 1609.344 };

function unitOf(raw: string): { kind: 'time' | 'distance'; unit: string } | null {
  const u = raw.toLowerCase().replace(/\.$/, '');
  if (/^(s|sec|secs|second|seconds)$/.test(u)) return { kind: 'time', unit: 's' };
  if (/^(min|mins|minute|minutes)$/.test(u)) return { kind: 'time', unit: 'min' };
  if (/^(h|hr|hrs|hour|hours)$/.test(u)) return { kind: 'time', unit: 'h' };
  // A bare "m" is meters, the SI symbol. Drona writes minutes as "min".
  if (/^(m|meter|meters|metre|metres)$/.test(u)) return { kind: 'distance', unit: 'm' };
  if (/^(km|kms|kilometer|kilometers|kilometre|kilometres)$/.test(u)) return { kind: 'distance', unit: 'km' };
  if (/^(mi|mile|miles)$/.test(u)) return { kind: 'distance', unit: 'mi' };
  return null;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const AMOUNT = new RegExp(String.raw`^\s*${NUM}(?:\s*(?:[-–]|to)\s*${NUM})?\s*([a-z]+\.?)\s*$`, 'i');
const CLOCK = /^\s*(\d+):([0-5]\d)\s*$/;

export interface TimedTarget {
  /** Seconds for a time target, else undefined. */
  duration_seconds?: number;
  /** Meters for a distance target, else undefined. */
  distance_m?: number;
  /** "30-45s": the low end is the target, the range is worth keeping in the cue. */
  range: boolean;
  /** Written with a bare "m", which could mean minutes as easily as meters. */
  bareM?: boolean;
}

/**
 * Read a time or distance target out of a plan's reps text: "45s", "30-45s",
 * "20min", "1:30", "5km", "400m". A range keeps its low end, the same way a
 * rep range prefills reps_min. Anything else (a rep count, "AMRAP") is null.
 */
export function parseTimedTarget(text: string | null | undefined): TimedTarget | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const clock = CLOCK.exec(t);
  if (clock) {
    const secs = Number(clock[1]) * 60 + Number(clock[2]);
    return secs > 0 ? { duration_seconds: secs, range: false } : null;
  }
  const m = AMOUNT.exec(t);
  if (!m) return null;
  const unit = unitOf(m[3]);
  if (!unit) return null;
  const lo = Number(m[1]);
  const hi = m[2] != null ? Number(m[2]) : null;
  if (!(lo > 0) || (hi != null && !(hi > lo))) return null;
  const range = hi != null;
  if (unit.kind === 'time') {
    const secs = Math.round(lo * UNIT_SECONDS[unit.unit]);
    return secs > 0 ? { duration_seconds: secs, range } : null;
  }
  const meters = Math.round(lo * UNIT_METERS[unit.unit] * 100) / 100;
  if (!(meters > 0)) return null;
  return /^m\.?$/i.test(m[3]) ? { distance_m: meters, range, bareM: true } : { distance_m: meters, range };
}

/** Below this, a bare "m" on an exercise that logs time (a run) is read as
 *  minutes, not meters: "5m" of running is five minutes, "400m" is a lap. */
const BARE_M_MIN_METERS_ON_TIMED = 100;

/**
 * Whether a target's distance can be stored as written. Only a bare "m" is in
 * doubt (meters or minutes?): it needs a metric type that logs distance, and
 * on one that also logs time it needs to be a plausible distance.
 */
export function trustDistanceUnit(t: TimedTarget, metricType: string | null | undefined): boolean {
  if (!t.bareM) return true;
  if (metricType == null || !takesDistanceTarget(metricType)) return false;
  return !takesDurationTarget(metricType) || (t.distance_m ?? 0) >= BARE_M_MIN_METERS_ON_TIMED;
}

/** A short label for a target: "0:45", "20:00", "5 km". Null when there is none. */
export function formatRoutineTarget(t: RoutineTargets): string | null {
  const parts: string[] = [];
  if (t.target_distance_m) parts.push(`${formatDistanceKm(t.target_distance_m)} km`);
  if (t.target_duration_seconds) parts.push(formatDuration(t.target_duration_seconds));
  return parts.length ? parts.join(' in ') : null;
}

/**
 * The target worth showing for a slot whose exercise is measured this way:
 * a time for a timed type, a distance for a distance type. Null for a
 * rep-based exercise, even if a stale target sits on the row (an exercise
 * swapped for a lift keeps the row, and its target means nothing there).
 */
export function slotTargetLabel(metricType: string | null | undefined, t: RoutineTargets): string | null {
  return formatRoutineTarget(targetsFor(metricType, t));
}

/** Only the targets this metric type logs: a time for a timed type, a
 *  distance for a distance type. Anything else is dropped as stale. */
export function targetsFor(metricType: string | null | undefined, t: Partial<RoutineTargets>): RoutineTargets {
  return {
    target_duration_seconds: takesDurationTarget(metricType) ? t.target_duration_seconds ?? null : null,
    target_distance_m: takesDistanceTarget(metricType) ? t.target_distance_m ?? null : null,
  };
}

/** Routine editor fields ("0:45", "5") for a slot's targets. */
export function targetEditorText(t: RoutineTargets): { duration: string; distance: string } {
  return {
    duration: t.target_duration_seconds ? formatDuration(t.target_duration_seconds) : '',
    distance: t.target_distance_m ? formatDistanceKm(t.target_distance_m) : '',
  };
}

/**
 * The routine editor's Time field in seconds: "0:45", "1:30", a plain "45"
 * (seconds), or a unit ("45s", "1.5 min"). Anything else is 0, never a guess:
 * parseDuration alone read "1.5" as 1 second.
 */
export function parseEditorDuration(text: string | null | undefined): number {
  const t = (text ?? '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t.includes(':')) return parseDuration(t);
  return parseTimedTarget(t)?.duration_seconds ?? 0;
}

/**
 * Routine editor fields back to targets. A field the exercise does not log
 * saves nothing, so picking a lift over a stretch drops the stretch's time.
 * An unknown metric type (a row from a cache without it) keeps what was
 * loaded rather than guess it away. The time field is read by
 * parseEditorDuration; distance is km.
 */
export function targetsFromEditor(
  metricType: string | null | undefined,
  text: { duration?: string; distance?: string },
): RoutineTargets {
  const known = metricType != null;
  const secs = !known || takesDurationTarget(metricType) ? parseEditorDuration(text.duration) : 0;
  const meters = !known || takesDistanceTarget(metricType) ? parseDistanceKm(text.distance ?? '') : 0;
  return { target_duration_seconds: secs > 0 ? secs : null, target_distance_m: meters > 0 ? meters : null };
}

/**
 * Only the target keys that are set. A write sends these and nothing else, so
 * a rep-based row never names the new columns and keeps working against a
 * database that predates them.
 */
export function targetColumns(t: Partial<RoutineTargets> | null | undefined): Partial<RoutineTargets> {
  const out: Partial<RoutineTargets> = {};
  const secs = positive(t?.target_duration_seconds);
  const meters = positive(t?.target_distance_m);
  if (secs != null) out.target_duration_seconds = Math.round(secs);
  if (meters != null) out.target_distance_m = meters;
  return out;
}

/** Strip the target keys from a row, for the retry against an older database. */
export function withoutTargetColumns<T extends object>(row: T): Omit<T, keyof RoutineTargets> {
  const { target_duration_seconds: _d, target_distance_m: _m, ...rest } = row as T & Partial<RoutineTargets>;
  return rest;
}

/**
 * A write failed because the target columns are not there yet (the app shipped
 * before the migration, or PostgREST's schema cache is stale). Only this
 * mismatch is retried without them; any other error stays an error.
 */
export function missingTargetColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && ['42703', 'PGRST204'].includes(error.code ?? '')
    && /target_(duration_seconds|distance_m)/.test(error.message ?? '');
}

/**
 * Run a write that may name the target columns, and run it again without them
 * when the database predates them. write(true) is the normal write;
 * write(false) is the same write without the targets (stripped, or carried in
 * the cue). Any other error is returned as is. Every routine_exercises writer
 * that can carry a target goes through here, so the fallback is one rule.
 */
export async function writeWithTargetFallback<E extends { code?: string; message?: string }>(
  write: (targetColumns: boolean) => PromiseLike<{ error: E | null }>,
): Promise<E | null> {
  const { error } = await write(true);
  if (!missingTargetColumn(error)) return error;
  return (await write(false)).error;
}
