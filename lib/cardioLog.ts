/**
 * Cardio from the dashboard: the rules behind the cardio sheet
 * (components/program/CardioSheet.tsx).
 *
 *   - "Log one you did" builds a finished workout for the offline queue
 *     (lib/syncQueue), the same entry a normal Finish writes, so XP, stats and
 *     the weekly facts all see it. One completed, non-warmup set of a timed
 *     Cardio exercise: exactly what isCardioSet counts.
 *   - "Start cardio" hands one exercise to the workout screen, which starts an
 *     empty session with it already in (app/workout/[id].tsx, id 'new').
 *   - Queued workouts count toward this week's cardio before they sync, so the
 *     card moves the moment you save, not when the flush lands.
 *
 * No app imports on purpose (only the shared, import-free activity rules), so
 * `deno test` reaches it. The entry shapes below mirror lib/syncQueue's
 * PendingWorkout; the caller's assignment to that type keeps them in step.
 */
import { CARDIO_METRIC_TYPES, CARDIO_MUSCLE_GROUP, localDayOf, type CardioSetRow } from "./activityGoals";

/** A cardio exercise as the sheet offers it. id is null for an offline fallback row. */
export interface CardioExercise {
  id: string | null;
  name: string;
  category: string;
  metric_type: "duration" | "distance_duration" | "resistance_duration";
}

/**
 * Shown when the catalog read fails (offline). Real catalog names, so the
 * flusher resolves each one to its row by name at sync time.
 */
export const FALLBACK_CARDIO: CardioExercise[] = [
  { id: null, name: "Outdoor Run", category: "Bodyweight", metric_type: "distance_duration" },
  { id: null, name: "Outdoor Walk", category: "Bodyweight", metric_type: "distance_duration" },
  { id: null, name: "Treadmill Run", category: "Machine", metric_type: "distance_duration" },
  { id: null, name: "Incline Treadmill Walk", category: "Machine", metric_type: "distance_duration" },
  { id: null, name: "Stationary Bike", category: "Machine", metric_type: "distance_duration" },
  { id: null, name: "Rowing Machine", category: "Machine", metric_type: "distance_duration" },
  { id: null, name: "Stair Climber", category: "Machine", metric_type: "distance_duration" },
  { id: null, name: "Swimming", category: "Other", metric_type: "distance_duration" },
  { id: null, name: "Jump Rope", category: "Other", metric_type: "duration" },
];

/** The ones most people mean by "cardio" go first; the rest follow by name. */
const POPULAR = [
  "Outdoor Run", "Outdoor Walk", "Treadmill Run", "Incline Treadmill Walk",
  "Stationary Bike", "Rowing Machine", "Stair Climber", "Elliptical",
];

/**
 * Catalog rows (and the user's own) that can count as a cardio session: the
 * Cardio group and a timed metric. Burpee is Cardio but counted in reps, so it
 * never could count and is left out. Deduped by name, popular first.
 */
export function cardioChoices(
  rows: ReadonlyArray<{ id?: string | null; name?: string | null; category?: string | null; muscle_group?: string | null; metric_type?: string | null }>,
): CardioExercise[] {
  const seen = new Set<string>();
  const out: CardioExercise[] = [];
  for (const r of rows) {
    const name = (r.name ?? "").trim();
    if (!name || r.muscle_group !== CARDIO_MUSCLE_GROUP) continue;
    if (!CARDIO_METRIC_TYPES.includes(r.metric_type ?? "")) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id ?? null,
      name,
      category: r.category ?? "Other",
      metric_type: r.metric_type as CardioExercise["metric_type"],
    });
  }
  const rank = (n: string) => {
    const i = POPULAR.indexOf(n);
    return i < 0 ? POPULAR.length : i;
  };
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export const usesDistance = (ex: CardioExercise) => ex.metric_type === "distance_duration";

export const MIN_MINUTES = 5;
export const MAX_MINUTES = 240;
export const DEFAULT_MINUTES = 30;
/** How far back "Log one you did" reaches: this day and the six before it. */
export const LOG_DAYS_BACK = 6;

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface CardioDay {
  /** Local calendar day, 'YYYY-MM-DD'. */
  iso: string;
  /** "Today", "Yesterday", then the weekday ("Wed"). */
  label: string;
}

/** Today and the six days before it, newest first. Never a future day. */
export function cardioDays(now: Date): CardioDay[] {
  const days: CardioDay[] = [];
  for (let i = 0; i <= LOG_DAYS_BACK; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const label = i === 0
      ? "Today"
      : i === 1
      ? "Yesterday"
      : d.toLocaleDateString("en-US", { weekday: "short" });
    days.push({ iso: ymd(d), label });
  }
  return days;
}

/**
 * When a logged session started. Today: it just ended, so now minus its length.
 * An earlier day: it ended at 6 pm that day. Either way it never starts in the
 * future and stays inside its own local day.
 */
export function cardioStartedAt(dayIso: string, minutes: number, now: Date): Date {
  const [y, m, d] = dayIso.split("-").map((n) => parseInt(n, 10));
  const isToday = dayIso === ymd(now);
  const end = isToday ? now : new Date(y, m - 1, d, 18, 0, 0, 0);
  const start = new Date(end.getTime() - minutes * 60_000);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0);
  return start < dayStart ? dayStart : start;
}

export interface CardioLogInput {
  clientId: string;
  ownerId: string;
  exercise: CardioExercise;
  minutes: number;
  /** Kilometres; 0 or less = no distance. Ignored for an exercise without a distance axis. */
  distanceKm: number;
  dayIso: string;
  now: Date;
}

/** One finished cardio workout, in lib/syncQueue's PendingWorkout shape. */
export function buildCardioLogEntry(input: CardioLogInput) {
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(input.minutes)));
  const distance_m = usesDistance(input.exercise) && input.distanceKm > 0
    ? Math.round(input.distanceKm * 1000)
    : null;
  return {
    schema: 1 as const,
    clientId: input.clientId,
    ownerId: input.ownerId,
    name: input.exercise.name,
    notes: null,
    startedAtIso: cardioStartedAt(input.dayIso, minutes, input.now).toISOString(),
    durationSeconds: minutes * 60,
    // Cardio moves no load: no volume, the same as the workout screen's sum.
    totalVolumeKg: 0,
    linkedRoutineId: null,
    exercises: [{
      def: {
        name: input.exercise.name,
        muscle_group: CARDIO_MUSCLE_GROUP,
        category: input.exercise.category,
        metric_type: input.exercise.metric_type,
      },
      resolvedExerciseId: input.exercise.id,
      supersetGroup: null,
      note: null,
      sets: [{
        weight_kg: 0,
        reps: 0,
        order: 0,
        duration_seconds: minutes * 60,
        distance_m,
        resistance: null,
        set_type: "normal" as const,
        rpe: null,
        is_unilateral: false,
        reps_right: null,
        rpe_right: null,
        weight_kg_right: null,
      }],
    }],
    phase: "queued" as const,
    serverWorkoutId: null,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: input.now.getTime(),
  };
}

/** The bits of a queued workout the cardio count reads. */
export interface QueuedWorkoutLike {
  clientId: string;
  startedAtIso: string;
  exercises: ReadonlyArray<{
    def: { muscle_group?: string | null; metric_type?: string | null };
    sets: ReadonlyArray<{ set_type?: string | null }>;
  }>;
}

/**
 * Queued (not yet synced) workouts from this week as count rows. Every queued
 * set is a completed one (the finish keeps only those). A workout the server
 * already has, by client id, is skipped so it never counts twice.
 */
export function queuedCardioRows(
  queued: ReadonlyArray<QueuedWorkoutLike>,
  weekStart: Date,
  serverClientIds: ReadonlySet<string>,
): CardioSetRow[] {
  const rows: CardioSetRow[] = [];
  for (const w of queued) {
    if (serverClientIds.has(w.clientId)) continue;
    const t = Date.parse(w.startedAtIso);
    if (!Number.isFinite(t) || t < weekStart.getTime()) continue;
    const day = localDayOf(w.startedAtIso);
    for (const ex of w.exercises) {
      for (const s of ex.sets) {
        rows.push({
          workout_id: `queued:${w.clientId}`,
          completed: true,
          set_type: s.set_type ?? "normal",
          muscle_group: ex.def.muscle_group ?? null,
          metric_type: ex.def.metric_type ?? null,
          // Queued workouts are always logged in the app; an import goes straight to the server.
          source: null,
          day,
        });
      }
    }
  }
  return rows;
}

// ── "Start cardio" hand-off to the workout screen ─────────────────────────────
// The sheet sets it and opens /workout/new; the screen takes it once when it
// starts the empty session. One-shot, and it goes stale after a minute: if the
// workout screen never took it (the push failed, or it resumed another
// session), a later plain "new workout" must not start with this exercise.
export const CARDIO_START_TTL_MS = 60_000;

let pendingStart: { ex: CardioExercise; at: number } | null = null;

export function setCardioStart(ex: CardioExercise, now: number = Date.now()): void {
  pendingStart = { ex, at: now };
}

export function takeCardioStart(now: number = Date.now()): CardioExercise | null {
  const p = pendingStart;
  pendingStart = null;
  if (!p || now - p.at > CARDIO_START_TTL_MS) return null;
  return p.ex;
}
