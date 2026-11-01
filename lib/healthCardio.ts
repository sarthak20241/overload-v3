/**
 * Cardio from the health hub (Apple Health / Health Connect) -> Overload workouts.
 *
 * A run on a watch counts toward the phase's cardio goal only if it lands as a
 * finished Overload workout with one completed, timed Cardio set (the rule in
 * supabase/functions/_shared/activityGoals.ts). This file decides WHICH hub
 * workouts become one:
 *   - cardio activity types only, each mapped to a catalog Cardio exercise;
 *     strength, yoga and sports sessions from a watch are never imported;
 *   - long enough to be a session (walks need more: Samsung Health saves every
 *     10 minute walk on its own, and steps already count those);
 *   - not overlapping a cardio workout logged in the app (a run logged by hand
 *     and on the watch counts once), nor the workout in progress;
 *   - not overlapping another hub workout (Strava and the watch can both write
 *     the same run to Apple Health).
 *
 * The database checks the same overlap again (import_health_cardio, migration
 * 20261101120000) against workouts already synced; this side covers what only
 * the phone knows: queued workouts not yet synced and the live session.
 *
 * Pure on purpose: no imports, so `deno test lib/healthCardio.test.ts` reaches it.
 */

export type CardioHub = 'healthkit' | 'health_connect';

/** One workout as read from the hub, before any filtering. */
export interface HubWorkout {
  hub: CardioHub;
  /** The hub's own id (HealthKit uuid, Health Connect metadata.id). */
  externalId: string;
  /** HealthKit WorkoutActivityType or Health Connect ExerciseType number. */
  activityType: number;
  /** HealthKit's HKIndoorWorkout metadata; Health Connect says it in the type. */
  indoor?: boolean;
  startMs: number;
  endMs: number;
  /** Active time when the hub reports it (HealthKit excludes pauses); else end - start. */
  durationSeconds?: number | null;
  distanceM?: number | null;
}

/** What a cardio activity becomes in Overload. */
export interface CardioKind {
  /** Catalog exercise name (exercises.created_by is null, muscle_group 'Cardio'). */
  exercise: string;
  /** The workout's name in History. */
  label: string;
  /** Shortest session imported, in minutes. */
  minMinutes: number;
}

const MIN_MINUTES = 5;
const WALK_MIN_MINUTES = 20;

const RUN: CardioKind = { exercise: 'Outdoor Run', label: 'Run', minMinutes: MIN_MINUTES };
const TREADMILL_RUN: CardioKind = { exercise: 'Treadmill Run', label: 'Treadmill run', minMinutes: MIN_MINUTES };
const WALK: CardioKind = { exercise: 'Outdoor Walk', label: 'Walk', minMinutes: WALK_MIN_MINUTES };
const TREADMILL_WALK: CardioKind = { exercise: 'Treadmill Walk', label: 'Treadmill walk', minMinutes: WALK_MIN_MINUTES };
const HIKE: CardioKind = { exercise: 'Trail Running/Walking', label: 'Hike', minMinutes: WALK_MIN_MINUTES };
const RIDE: CardioKind = { exercise: 'Cycling', label: 'Ride', minMinutes: MIN_MINUTES };
const BIKE: CardioKind = { exercise: 'Stationary Bike', label: 'Bike', minMinutes: MIN_MINUTES };
const SWIM: CardioKind = { exercise: 'Swimming', label: 'Swim', minMinutes: MIN_MINUTES };
const ROW: CardioKind = { exercise: 'Rowing Machine', label: 'Row', minMinutes: MIN_MINUTES };
const ELLIPTICAL: CardioKind = { exercise: 'Elliptical', label: 'Elliptical', minMinutes: MIN_MINUTES };
const STAIRS: CardioKind = { exercise: 'Stair Climber', label: 'Stairs', minMinutes: MIN_MINUTES };
const HIIT: CardioKind = { exercise: 'HIIT', label: 'HIIT', minMinutes: MIN_MINUTES };
const JUMP_ROPE: CardioKind = { exercise: 'Jump Rope', label: 'Jump rope', minMinutes: MIN_MINUTES };

/**
 * HealthKit WorkoutActivityType values (@kingstinct/react-native-healthkit's
 * generated enum, which mirrors HKWorkoutActivityType). Anything not listed,
 * strength training above all, is not cardio here.
 */
const HEALTHKIT_KINDS: Record<number, { outdoor: CardioKind; indoor?: CardioKind }> = {
  37: { outdoor: RUN, indoor: TREADMILL_RUN }, // running
  71: { outdoor: RUN }, // wheelchairRunPace
  52: { outdoor: WALK, indoor: TREADMILL_WALK }, // walking
  70: { outdoor: WALK }, // wheelchairWalkPace
  24: { outdoor: HIKE }, // hiking
  13: { outdoor: RIDE, indoor: BIKE }, // cycling
  74: { outdoor: RIDE }, // handCycling
  46: { outdoor: SWIM }, // swimming
  35: { outdoor: ROW }, // rowing
  16: { outdoor: ELLIPTICAL }, // elliptical
  44: { outdoor: STAIRS }, // stairClimbing
  68: { outdoor: STAIRS }, // stairs
  69: { outdoor: STAIRS }, // stepTraining
  63: { outdoor: HIIT }, // highIntensityIntervalTraining
  73: { outdoor: HIIT }, // mixedCardio
  30: { outdoor: HIIT }, // mixedMetabolicCardioTraining
  64: { outdoor: JUMP_ROPE }, // jumpRope
};

/** Health Connect ExerciseType values (react-native-health-connect's ExerciseType). */
const HEALTH_CONNECT_KINDS: Record<number, CardioKind> = {
  56: RUN, // RUNNING
  57: TREADMILL_RUN, // RUNNING_TREADMILL
  79: WALK, // WALKING
  37: HIKE, // HIKING
  8: RIDE, // BIKING
  9: BIKE, // BIKING_STATIONARY
  73: SWIM, // SWIMMING_OPEN_WATER
  74: SWIM, // SWIMMING_POOL
  53: ROW, // ROWING
  54: ROW, // ROWING_MACHINE
  25: ELLIPTICAL, // ELLIPTICAL
  68: STAIRS, // STAIR_CLIMBING
  69: STAIRS, // STAIR_CLIMBING_MACHINE
  36: HIIT, // HIGH_INTENSITY_INTERVAL_TRAINING
};

/** The cardio kind for a hub workout, or null when it is not cardio. */
export function cardioKind(w: Pick<HubWorkout, 'hub' | 'activityType' | 'indoor'>): CardioKind | null {
  if (w.hub === 'healthkit') {
    const k = HEALTHKIT_KINDS[w.activityType];
    if (!k) return null;
    return w.indoor && k.indoor ? k.indoor : k.outdoor;
  }
  return HEALTH_CONNECT_KINDS[w.activityType] ?? null;
}

/** A stretch of time already taken by a workout logged in the app. */
export interface BusyWindow {
  startMs: number;
  endMs: number;
}

/** One hub workout to save, as import_health_cardio takes it. */
export interface CardioImport {
  source: CardioHub;
  externalId: string;
  exercise: string;
  name: string;
  startedAtIso: string;
  durationSeconds: number;
  distanceM: number | null;
}

const overlaps = (a: BusyWindow, b: BusyWindow) => a.startMs < b.endMs && b.startMs < a.endMs;

/**
 * The hub workouts to import, oldest first. `busy` is every in-app cardio
 * workout the server may not know yet (queued, not synced) plus the session in
 * progress; `nowMs` drops anything that has not ended.
 */
export function planCardioImports(workouts: HubWorkout[], busy: BusyWindow[], nowMs: number): CardioImport[] {
  const sorted = [...workouts].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const seen = new Set<string>();
  const taken: BusyWindow[] = [];
  const out: CardioImport[] = [];
  for (const w of sorted) {
    if (!w.externalId || seen.has(w.externalId)) continue;
    seen.add(w.externalId);
    if (!(w.endMs > w.startMs) || w.endMs > nowMs) continue;
    const kind = cardioKind(w);
    if (!kind) continue;
    const reported = w.durationSeconds != null && Number.isFinite(w.durationSeconds) && w.durationSeconds > 0
      ? w.durationSeconds
      : (w.endMs - w.startMs) / 1000;
    const durationSeconds = Math.round(reported);
    if (durationSeconds < kind.minMinutes * 60) continue;
    const span = { startMs: w.startMs, endMs: w.endMs };
    if (busy.some((b) => overlaps(b, span))) continue;
    // The longest of two overlapping hub copies wins: sorted by start, then
    // longest first, so the one kept is the earlier, longer record.
    if (taken.some((t) => overlaps(t, span))) continue;
    taken.push(span);
    const distance = w.distanceM != null && Number.isFinite(w.distanceM) && w.distanceM > 0
      ? Math.round(w.distanceM)
      : null;
    out.push({
      source: w.hub,
      externalId: w.externalId,
      exercise: kind.exercise,
      name: kind.label,
      startedAtIso: new Date(w.startMs).toISOString(),
      durationSeconds,
      distanceM: distance,
    });
  }
  return out;
}

const TIMED = ['duration', 'distance_duration', 'resistance_duration'];

/** A queued workout as lib/syncQueue keeps it (only the fields read here). */
export interface QueuedWorkoutLike {
  startedAtIso: string;
  durationSeconds: number;
  exercises: {
    def: { muscle_group: string; metric_type?: string };
    sets: { set_type?: string }[];
  }[];
}

/**
 * The time each queued workout with a cardio set covers. Same set rule as
 * isCardioSet: a timed Cardio exercise with a non-warmup set (queued sets are
 * completed ones only).
 */
export function queuedCardioWindows(queue: QueuedWorkoutLike[]): BusyWindow[] {
  const out: BusyWindow[] = [];
  for (const q of queue) {
    const cardio = q.exercises.some((ex) =>
      ex.def.muscle_group === 'Cardio'
      && TIMED.includes(ex.def.metric_type ?? '')
      && ex.sets.some((s) => s.set_type !== 'warmup'));
    if (!cardio) continue;
    const startMs = Date.parse(q.startedAtIso);
    if (!Number.isFinite(startMs)) continue;
    out.push({ startMs, endMs: startMs + Math.max(0, q.durationSeconds) * 1000 });
  }
  return out;
}

/** "From Apple Health" / "From Health Connect" for a workouts.source, or null for in-app. */
export function importedFromLabel(source: string | null | undefined): string | null {
  if (source === 'healthkit') return 'From Apple Health';
  if (source === 'health_connect') return 'From Health Connect';
  return null;
}

/**
 * Did saving this workout award XP? Only a workout logged in the app does:
 * import_health_cardio never calls award_xp, so deleting an imported one must
 * not refund any.
 */
export function earnedXp(source: string | null | undefined): boolean {
  return source == null;
}
