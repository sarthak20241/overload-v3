// ─── Hevy CSV import ─────────────────────────────────────────────────────────
//
// Pure, dependency-free parser + mapper for a Hevy "Export Workouts" CSV. Kept
// free of React-Native imports so it can be unit-tested in plain Node and reused
// anywhere. The UI layer (app/(app)/import.tsx) picks/reads the file and feeds
// its text here, then enqueues the returned entries through the normal
// offline-sync write path (lib/syncQueue) — so imported workouts insert exactly
// like ones finished in-app: RLS-safe, idempotent, exercise-resolving, cached.
//
// Hevy's export is one row PER SET, columns:
//   title, start_time, end_time, description, exercise_title, superset_id,
//   exercise_notes, set_index, set_type, weight_kg, reps, distance_km,
//   duration_seconds, rpe
// Rows are grouped into workouts by (start_time, title); contiguous rows with
// the same exercise_title form one exercise block.

import type { PendingWorkout, PendingSet, PendingExercise } from '@/lib/syncQueue';
import type { SetType } from '@/lib/types';
import { EXERCISE_LIBRARY, type MetricType } from '@/lib/exercises';

const LBS_TO_KG = 0.45359237;
const SCHEMA = 1 as const;

export type ImportUnit = 'kg' | 'lbs';

/** One parsed CSV record, keyed by the (lower-cased) Hevy column names. */
export type HevyRow = Record<string, string>;

// ─── RFC-4180 CSV parser ─────────────────────────────────────────────────────
// Handles quoted fields with embedded commas, newlines, and "" escaped quotes,
// plus \n / \r\n line endings. Returns an array of records keyed by the header
// row. A hand-rolled parser (rather than a dependency) keeps this module pure.
export function parseCsv(text: string): HevyRow[] {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  // Strip a leading UTF-8 BOM if present.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { pushField(); rows.push(record); record = []; };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRecord();
    } else if (c === '\r') {
      // swallow; the \n (if any) triggers the record. Bare \r also ends a record.
      if (s[i + 1] !== '\n') pushRecord();
    } else {
      field += c;
    }
  }
  // Flush the final field/record if the file didn't end with a newline.
  if (field.length > 0 || record.length > 0) pushRecord();

  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const out: HevyRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    // Skip fully-empty trailing lines.
    if (cols.length === 1 && cols[0].trim() === '') continue;
    const rec: HevyRow = {};
    for (let c = 0; c < header.length; c++) rec[header[c]] = cols[c] ?? '';
    out.push(rec);
  }
  return out;
}

// ─── Date parsing ────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a Hevy timestamp like "3 Jun 2026, 10:48" (also tolerates seconds and
 * am/pm). Interpreted in the runtime's local timezone — Hevy exports wall-clock
 * local time with no offset, so this keeps a workout on the day it happened.
 * Returns null when unparseable.
 */
export function parseHevyDate(raw: string): Date | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // "3 Jun 2026, 10:48" / "3 Jun 2026, 10:48:05" / "3 Jun 2026, 8:05 pm"
  const m = s.match(
    /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/,
  );
  if (!m) {
    const d = new Date(s);              // last-ditch: let the engine try
    return isNaN(d.getTime()) ? null : d;
  }
  const day = parseInt(m[1], 10);
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  const year = parseInt(m[3], 10);
  let hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const sec = m[6] ? parseInt(m[6], 10) : 0;
  const ampm = m[7]?.toLowerCase();
  if (mon === undefined) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const d = new Date(year, mon, day, hour, min, sec);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Value helpers ───────────────────────────────────────────────────────────
function num(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

const SET_TYPES: readonly SetType[] = ['normal', 'warmup', 'dropset', 'failure', 'negative', 'left', 'right'];
function mapSetType(raw: string | undefined): SetType {
  const s = (raw ?? '').trim().toLowerCase();
  return (SET_TYPES as readonly string[]).includes(s) ? (s as SetType) : 'normal';
}

const LIBRARY_NAMES = new Set(EXERCISE_LIBRARY.map((e) => e.name.toLowerCase()));

/**
 * Deterministic uuid-shaped id from a stable key (FNV-1a → 128 bits), so
 * re-importing the same file produces the same workouts.client_id and the
 * per-user unique index dedupes instead of creating duplicate workouts.
 */
export function stableClientId(key: string): string {
  // Four independently-seeded 32-bit FNV-1a passes → 128 bits of hex.
  const seeds = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0xcafebabe];
  const parts = seeds.map((seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  });
  const hex = parts.join('');                       // 32 hex chars
  // Shape as a v4-ish uuid (version/variant nibbles set for validity).
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

/** Which metric_type a *new* (custom) exercise should get, inferred from the
 *  axes Hevy actually populated across its sets. Matched library exercises keep
 *  their own type (the resolver ignores this def field for existing rows). */
function inferMetricType(opts: { hasWeight: boolean; hasReps: boolean; hasDuration: boolean; hasDistance: boolean }): MetricType {
  if (opts.hasDistance) return opts.hasWeight ? 'weight_distance' : 'distance_duration';
  if (opts.hasDuration && !opts.hasReps) return opts.hasWeight ? 'duration_weight' : 'duration';
  return 'weight_reps';
}

export interface HevyImportSummary {
  workoutCount: number;
  exerciseCount: number;        // distinct exercise names across the file
  setCount: number;             // total sets that will be written
  newExerciseCount: number;     // names not in the built-in library (become customs)
  skippedWorkoutCount: number;  // groups dropped (e.g. unparseable date)
  earliest: string | null;      // ISO of the oldest workout
  latest: string | null;        // ISO of the newest workout
}

export interface HevyImportResult {
  workouts: PendingWorkout[];
  summary: HevyImportSummary;
}

/**
 * Turn Hevy CSV text into ready-to-enqueue PendingWorkout entries for one user.
 * Pure: does no I/O and touches no queue — the caller enqueues + flushes.
 */
export function buildHevyImport(opts: {
  csvText: string;
  userId: string;
  unit: ImportUnit;
  createdAt?: number;   // injectable for deterministic tests
}): HevyImportResult {
  const { csvText, userId, unit } = opts;
  const createdAtBase = opts.createdAt ?? Date.now();
  const rows = parseCsv(csvText);
  const toKg = unit === 'lbs' ? (w: number) => w * LBS_TO_KG : (w: number) => w;

  // Group rows into workouts by (start_time, title), preserving first-seen order.
  const order: string[] = [];
  const groups = new Map<string, HevyRow[]>();
  for (const row of rows) {
    const key = `${row['start_time'] ?? ''} ${row['title'] ?? ''}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(row);
  }

  const workouts: PendingWorkout[] = [];
  const distinctExercises = new Set<string>();
  const newExercises = new Set<string>();
  let setCount = 0;
  let skippedWorkoutCount = 0;
  let earliest: number | null = null;
  let latest: number | null = null;

  order.forEach((key, wIdx) => {
    const g = groups.get(key)!;
    const first = g[0];
    const started = parseHevyDate(first['start_time'] ?? '');
    if (!started) { skippedWorkoutCount++; return; }
    const ended = parseHevyDate(first['end_time'] ?? '');
    const durationSeconds = ended ? Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000)) : 0;

    // Split into contiguous exercise blocks (new block when the title changes).
    const blocks: HevyRow[][] = [];
    let cur: HevyRow[] = [];
    let curName: string | null = null;
    for (const row of g) {
      const name = (row['exercise_title'] ?? '').trim();
      if (name !== curName) { if (cur.length) blocks.push(cur); cur = []; curName = name; }
      cur.push(row);
    }
    if (cur.length) blocks.push(cur);

    const pendingExercises: PendingExercise[] = [];
    let totalVolumeKg = 0;

    for (const block of blocks) {
      const name = (block[0]['exercise_title'] ?? '').trim();
      if (!name) continue;
      distinctExercises.add(name.toLowerCase());
      const isNew = !LIBRARY_NAMES.has(name.toLowerCase());
      if (isNew) newExercises.add(name.toLowerCase());

      let hasWeight = false, hasReps = false, hasDuration = false, hasDistance = false;
      const sets: PendingSet[] = block.map((row, idx) => {
        const rawW = num(row['weight_kg']);
        const reps = num(row['reps']) ?? 0;
        const dur = num(row['duration_seconds']);
        const distKm = num(row['distance_km']);
        const rpe = num(row['rpe']);
        const setType = mapSetType(row['set_type']);
        const weightKg = rawW != null ? toKg(rawW) : 0;
        if (rawW != null && rawW !== 0) hasWeight = true;
        if (reps !== 0) hasReps = true;
        if (dur != null) hasDuration = true;
        if (distKm != null) hasDistance = true;
        // Working volume excludes warmups (matches the server-side recompute).
        if (setType !== 'warmup') totalVolumeKg += weightKg * reps;
        setCount++;
        return {
          weight_kg: weightKg,
          reps,
          order: idx,
          duration_seconds: dur,
          distance_m: distKm != null ? distKm * 1000 : null,
          resistance: null,
          set_type: setType,
          rpe: rpe != null && rpe >= 1 && rpe <= 10 ? rpe : null,
          is_unilateral: false,
          reps_right: null,
          rpe_right: null,
          weight_kg_right: null,
        };
      });

      const supersetRaw = (block[0]['superset_id'] ?? '').trim();
      const supersetGroup = supersetRaw !== '' && !isNaN(Number(supersetRaw)) ? Number(supersetRaw) : null;

      pendingExercises.push({
        def: {
          name,
          muscle_group: 'Other',
          category: isNew ? 'Custom' : 'Other',
          metric_type: inferMetricType({ hasWeight, hasReps, hasDuration, hasDistance }),
        },
        resolvedExerciseId: null,   // resolved by name at flush (find-or-create)
        supersetGroup,
        sets,
      });
    }

    if (pendingExercises.length === 0) { skippedWorkoutCount++; return; }

    const startedMs = started.getTime();
    earliest = earliest == null ? startedMs : Math.min(earliest, startedMs);
    latest = latest == null ? startedMs : Math.max(latest, startedMs);

    const title = (first['title'] ?? '').trim() || 'Imported Workout';
    const desc = (first['description'] ?? '').trim();

    workouts.push({
      schema: SCHEMA,
      clientId: stableClientId(`hevy|${userId}|${first['start_time'] ?? ''}|${title}`),
      ownerId: userId,
      name: title,
      notes: desc || null,
      startedAtIso: started.toISOString(),
      durationSeconds,
      totalVolumeKg,
      linkedRoutineId: null,
      exercises: pendingExercises,
      phase: 'queued',
      serverWorkoutId: null,
      attempts: 0,
      nextAttemptAt: 0,
      // Preserve chronological order in the queue (oldest first, like flushQueue sorts).
      createdAt: createdAtBase + wIdx,
    });
  });

  return {
    workouts,
    summary: {
      workoutCount: workouts.length,
      exerciseCount: distinctExercises.size,
      setCount,
      newExerciseCount: newExercises.size,
      skippedWorkoutCount,
      earliest: earliest != null ? new Date(earliest).toISOString() : null,
      latest: latest != null ? new Date(latest).toISOString() : null,
    },
  };
}
