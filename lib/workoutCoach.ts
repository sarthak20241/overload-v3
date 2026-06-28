/**
 * In-workout coach context — turns the LIVE (in-memory) workout session into
 * something Coach Drona can reason about mid-set.
 *
 * Why this exists: an active workout's sets live only in the WorkoutProvider
 * context (hooks/useWorkout.tsx) until the workout is finished and written to
 * Supabase. The coach's server-side tools query the database, so they CANNOT
 * see the session that's happening right now. We bridge that gap on the client
 * by snapshotting the live state into a compact recap and injecting it as the
 * opening turn of the chat — the same trick RefineChatScreen uses to hand the
 * model a workout/plan recap it would otherwise have no way to see.
 *
 * The snapshot is taken once, at the moment the user opens the coach (see
 * app/workout/[id].tsx), so the context is stable for that chat session. The
 * user reopens to refresh it after logging more sets.
 */
import type { ActiveWorkoutExercise, SetType } from '@/lib/types';
import { metricTypeOf, metricTypeDef, type MetricType } from '@/lib/exercises';

export interface WorkoutCoachSet {
  weightKg: number;
  reps: number;
  // Phase B/C — so the coach reads the set faithfully (warmup vs working, effort,
  // and the non-weight/rep axes for duration/distance/resistance exercises).
  setType: SetType;
  rpe: number | null;          // 1-10; RIR = 10 - rpe
  durationSeconds: number | null;
  distanceM: number | null;
  resistance: number | null;
  // Unilateral "L+R" (migration 0056/0059). One set trained one side at a time;
  // reps/rpe = LEFT, repsRight/rpeRight = RIGHT; weightKg = LEFT weight,
  // weightKgRight = RIGHT (null => same). Still ONE working set.
  isUnilateral: boolean;
  repsRight: number | null;
  rpeRight: number | null;
  weightKgRight: number | null;
}

export interface WorkoutCoachExercise {
  name: string;
  muscleGroup?: string;
  isCurrent: boolean;
  finished: boolean;
  // Phase A — how this exercise is measured (drives how its sets read).
  metricType: MetricType;
  targetSets: number;
  repsMin: number;
  repsMax: number;
  restSeconds: number;
  coachNote?: string;
  loggedSets: WorkoutCoachSet[];
  previousSets?: { weightKg: number; reps: number }[];
}

export interface WorkoutCoachContext {
  // 'live' — opened mid-workout for quick, in-the-moment help.
  // 'review' — opened from the finish step to look back over the whole
  // session; the chat auto-asks the coach for a review on open.
  kind: 'live' | 'review';
  routineName: string;
  elapsedSeconds: number;
  exerciseCount: number;
  finishedCount: number;
  // Null when the workout has no exercises yet, or every exercise is finished.
  currentExerciseName: string | null;
  // The set number the user is about to perform on the current exercise
  // (completed sets + 1). Null when there's no current exercise.
  nextSetNumber: number | null;
  exercises: WorkoutCoachExercise[];
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function repRange(min: number, max: number): string {
  return min === max ? `${min}` : `${min}-${max}`;
}

const isWarmup = (s: WorkoutCoachSet) => s.setType === 'warmup';
/** Working sets = everything except warmups (mirrors volume/1RM/PR + the server). */
const workingSets = (sets: WorkoutCoachSet[]) => sets.filter((s) => !isWarmup(s));

function fmtDur(sec: number | null): string {
  const s = Math.max(0, Math.floor(sec ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const km = (m: number | null) => Math.round(((m ?? 0) / 1000) * 100) / 100;

const SET_TYPE_LABEL: Record<SetType, string> = {
  normal: '', warmup: 'warmup', dropset: 'drop set', failure: 'to failure',
  negative: 'negative', left: 'left side', right: 'right side',
};

/** The set's core value, in the units the exercise's metric_type uses. For a
 * unilateral set the rep count reads as left/right (weight is shared). */
function setCore(s: WorkoutCoachSet, mt: MetricType): string {
  const reps = s.isUnilateral ? `${s.reps}/${s.repsRight ?? 0}` : `${s.reps}`;
  // Per-side weight (migration 0059): when the two sides used different loads, spell
  // each side out (weight×reps / weight×reps); otherwise the compact shared form.
  const wR = s.weightKgRight ?? s.weightKg;
  const diffW = s.isUnilateral && wR !== s.weightKg;
  switch (mt) {
    case 'bodyweight_reps': return `${reps} reps`;
    case 'weighted_bodyweight': return diffW ? `+${s.weightKg}kg×${s.reps}/+${wR}kg×${s.repsRight ?? 0}` : `+${s.weightKg}kg×${reps}`;
    case 'assisted_bodyweight': return diffW ? `-${s.weightKg}kg×${s.reps}/-${wR}kg×${s.repsRight ?? 0}` : `-${s.weightKg}kg×${reps}`;
    case 'duration': return fmtDur(s.durationSeconds);
    case 'duration_weight': return `${s.weightKg}kg ${fmtDur(s.durationSeconds)}`;
    case 'distance_duration': return `${km(s.distanceM)}km ${fmtDur(s.durationSeconds)}`;
    case 'weight_distance': return `${s.weightKg}kg ${km(s.distanceM)}km`;
    case 'resistance_duration': return `L${s.resistance ?? 0} ${fmtDur(s.durationSeconds)}`;
    default: return diffW ? `${s.weightKg}kg×${s.reps}/${wR}kg×${s.repsRight ?? 0}` : `${s.weightKg}kg×${reps}`; // weight_reps
  }
}

/** Trailing (set type, RPE) tags. Warmups/drop/failure/etc. + effort + unilateral. */
function setSuffix(s: WorkoutCoachSet): string {
  const tags: string[] = [];
  if (s.setType !== 'normal' && SET_TYPE_LABEL[s.setType]) tags.push(SET_TYPE_LABEL[s.setType]);
  if (s.isUnilateral) tags.push('unilateral L+R');
  if (s.rpe != null) tags.push(s.isUnilateral && s.rpeRight != null ? `RPE ${s.rpe}/${s.rpeRight}` : `RPE ${s.rpe}`);
  return tags.length ? ` (${tags.join(', ')})` : '';
}

function setsToText(sets: WorkoutCoachSet[], mt: MetricType): string {
  return sets.map((s) => `${setCore(s, mt)}${setSuffix(s)}`).join(', ');
}

function prevSetsToText(sets: { weightKg: number; reps: number }[]): string {
  return sets.map((s) => `${s.weightKg}kg×${s.reps}`).join(', ');
}

/**
 * Snapshot the live workout into a structured context object. `currentIdx`
 * and `finished` come from the active-workout screen's local state (they
 * aren't in the WorkoutProvider), so this is called from there.
 */
export function buildWorkoutCoachContext(params: {
  routineName: string;
  elapsedSeconds: number;
  exercises: ActiveWorkoutExercise[];
  currentIdx: number;
  finished: boolean[];
  kind?: 'live' | 'review';
}): WorkoutCoachContext {
  const { routineName, elapsedSeconds, exercises, currentIdx, finished, kind = 'live' } = params;

  const mapped: WorkoutCoachExercise[] = exercises.map((ex, i) => {
    const logged: WorkoutCoachSet[] = ex.sets
      .filter((s) => s.completed)
      .map((s) => ({
        weightKg: s.weight_kg,
        reps: s.reps,
        setType: (s.set_type ?? 'normal') as SetType,
        rpe: s.rpe ?? null,
        durationSeconds: s.duration_seconds ?? null,
        distanceM: s.distance_m ?? null,
        resistance: s.resistance ?? null,
        isUnilateral: !!s.is_unilateral,
        repsRight: s.reps_right ?? null,
        rpeRight: s.rpe_right ?? null,
        weightKgRight: s.weight_kg_right ?? null,
      }));
    return {
      name: ex.exercise.name,
      muscleGroup: ex.exercise.muscle_group || undefined,
      isCurrent: i === currentIdx,
      finished: !!finished[i],
      metricType: metricTypeOf(ex.exercise),
      targetSets: ex.targetSets,
      repsMin: ex.repsMin,
      repsMax: ex.repsMax,
      restSeconds: ex.restSeconds,
      coachNote: ex.coachNote,
      loggedSets: logged,
      previousSets: ex.previousSets?.map((s) => ({ weightKg: s.weight_kg, reps: s.reps })),
    };
  });

  const current = mapped[currentIdx];
  const hasCurrent = !!current && !current.finished;

  return {
    kind,
    routineName: routineName || 'Workout',
    elapsedSeconds,
    exerciseCount: mapped.length,
    finishedCount: finished.filter(Boolean).length,
    currentExerciseName: hasCurrent ? current.name : null,
    nextSetNumber: hasCurrent ? workingSets(current.loggedSets).length + 1 : null,
    exercises: mapped,
  };
}

/**
 * Compact, model-readable recap of the live session. Injected as the opening
 * (synthetic) user turn so the coach can answer with full awareness of what's
 * been logged so far vs. the previous session, the current exercise, targets,
 * rest, and any carried-over coach cues.
 */
export function workoutCoachContextToText(ctx: WorkoutCoachContext): string {
  const lines: string[] = [];
  lines.push(`Routine: ${ctx.routineName}`);
  lines.push(`Time elapsed: ${fmtClock(ctx.elapsedSeconds)}`);
  if (ctx.exerciseCount > 0) {
    lines.push(`Progress: ${ctx.finishedCount} of ${ctx.exerciseCount} exercises finished`);
  }
  lines.push('');

  if (ctx.exerciseCount === 0) {
    lines.push('No exercises added to this session yet.');
    return lines.join('\n');
  }

  lines.push('Exercises:');
  ctx.exercises.forEach((ex, i) => {
    const status = ex.finished
      ? 'DONE'
      : ex.isCurrent
        ? `CURRENT (next: working set ${workingSets(ex.loggedSets).length + 1})`
        : 'not started';
    const muscle = ex.muscleGroup ? ` [${ex.muscleGroup}]` : '';
    const rest = ex.restSeconds > 0 ? `, rest ${ex.restSeconds}s` : '';
    // Only call out the measurement type when it isn't the plain weight×reps default.
    const metric = ex.metricType !== 'weight_reps' ? ` (${metricTypeDef(ex.metricType).label})` : '';
    lines.push(
      `${i + 1}. ${ex.name}${muscle}${metric} — target ${ex.targetSets}×${repRange(ex.repsMin, ex.repsMax)}${rest} — ${status}`,
    );
    if (ex.coachNote) lines.push(`   Coach cue: ${ex.coachNote}`);
    if (ex.loggedSets.length > 0) lines.push(`   Logged so far: ${setsToText(ex.loggedSets, ex.metricType)}`);
    if (ex.previousSets && ex.previousSets.length > 0) {
      lines.push(`   Last session: ${prevSetsToText(ex.previousSets)}`);
    }
  });

  return lines.join('\n');
}

/**
 * The full synthetic opener (user role) sent ahead of the conversation on
 * every request. Carries the recap plus behavioral guidance. Two framings:
 * live (mid-set, be terse and actionable) and review (session done, give a
 * structured read on how it went and what to change).
 */
export function workoutCoachOpener(ctx: WorkoutCoachContext): string {
  if (ctx.kind === 'review') {
    return [
      '[WORKOUT JUST COMPLETED]',
      'I just finished this workout and want your review. Here is the full session:',
      '',
      workoutCoachContextToText(ctx),
      '',
      'How to reply:',
      '- Give a tight, specific read — what went well and what to adjust.',
      '- Call out progression vs. last session wherever you can see it in the numbers.',
      '- Finish with 1-2 concrete things to change next time.',
      '- You may use your tools for deeper history if it genuinely helps.',
      "- Don't just restate my numbers back to me, interpret them.",
      '- Reading the recap: each set shows its value then (set type, RPE) in parens. Warmups are excluded from set counts and volume. RPE is 1 to 10 (RIR = 10 minus RPE). Times are m:ss, distance is km. A unilateral (L+R) set logs both sides as ONE set; reps read left/right and its volume counts both sides.',
    ].join('\n');
  }
  return [
    '[LIVE WORKOUT — happening right now]',
    "I'm in the middle of this workout and want fast, practical, in-the-moment coaching. Here's my current session:",
    '',
    workoutCoachContextToText(ctx),
    '',
    'How to reply while I train:',
    "- Be concise and direct — I'm between sets, keep it to the point.",
    '- Give a clear, immediately actionable call (weight, reps, rest, a swap, or stop/continue).',
    '- You may use your tools to check my training history if it genuinely helps, but don\'t stall.',
    "- Don't repeat this summary back to me.",
    '- Reading the recap: each set shows its value then (set type, RPE) in parens. Warmups are excluded from set counts and volume. RPE is 1 to 10 (RIR = 10 minus RPE). Times are m:ss, distance is km. A unilateral (L+R) set logs both sides as ONE set; reps read left/right and its volume counts both sides.',
  ].join('\n');
}

/**
 * The user turn auto-sent when the review chat opens, so the coach delivers
 * its read without the user having to type. The full session rides in the
 * synthetic opener above; this is the explicit ask the user "made".
 */
export function workoutCoachReviewRequest(_ctx: WorkoutCoachContext): string {
  return 'How did this session go? Did I progress vs. last time, and what should I focus on or change next session?';
}

function shorten(name: string, max = 18): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/**
 * The visible assistant greeting that opens the in-workout chat. Tailored to
 * where the user is in the session so it feels like the coach is watching.
 */
export function workoutCoachStarter(ctx: WorkoutCoachContext): string {
  if (ctx.kind === 'review') {
    const totalSets = ctx.exercises.reduce((n, e) => n + workingSets(e.loggedSets).length, 0);
    const volume = ctx.exercises.reduce(
      (sum, e) => sum + workingSets(e.loggedSets).reduce(
        (s, set) => s + set.weightKg * set.reps
          + (set.isUnilateral ? (set.weightKgRight ?? set.weightKg) * (set.repsRight ?? 0) : 0),
        0),
      0,
    );
    const mins = Math.round(ctx.elapsedSeconds / 60);
    return `Session logged — “${ctx.routineName}”: ${totalSets} set${totalSets === 1 ? '' : 's'}, ${Math.round(volume)}kg of volume in ${mins} min. Let me take a look…`;
  }
  if (ctx.exerciseCount === 0) {
    return `Blank canvas — “${ctx.routineName}” has no exercises yet. Tell me your goal and how much time you've got, and I'll get you moving.`;
  }
  if (!ctx.currentExerciseName) {
    return `Nice work — you've cleared every exercise in “${ctx.routineName}”. Want to add more, or call it here? Ask me anything.`;
  }
  const mins = Math.round(ctx.elapsedSeconds / 60);
  const timePart = mins >= 1 ? `${mins} min into “${ctx.routineName}”` : `just getting going on “${ctx.routineName}”`;
  return `You're ${timePart}, on ${ctx.currentExerciseName} (set ${ctx.nextSetNumber} next). I can see your whole session — ask me about weight, swaps, form, or whether to push or back off.`;
}

/**
 * Context-aware quick-question chips shown above the input until the user
 * sends their first message. Cuts typing mid-workout to a single tap.
 */
export function workoutCoachSuggestions(ctx: WorkoutCoachContext): string[] {
  const out: string[] = [];
  const current = ctx.exercises.find((e) => e.isCurrent && !e.finished);

  if (ctx.exerciseCount === 0) {
    return ['What should I train today?', 'Build me a quick session', 'I have 30 minutes'];
  }

  if (current) {
    if (current.loggedSets.length > 0 || (current.previousSets?.length ?? 0) > 0) {
      out.push('Is my next weight right?');
    }
    out.push(`Swap ${shorten(current.name)}`);
    if (current.coachNote) out.push('What does my coach cue mean?');
  }
  out.push('Add or drop a set?');
  out.push('Short on time — what matters?');

  // De-dupe and cap at 4 to keep the row tidy.
  return Array.from(new Set(out)).slice(0, 4);
}
