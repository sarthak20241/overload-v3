/**
 * Proactive insights engine — the deterministic detection layer behind the
 * dashboard's "Coach noticed" strip.
 *
 * Design split (see also useCoachAccess / the ai-coach edge function):
 *   - Detection is FREE and ungated. It's pure arithmetic over the workouts the
 *     dashboard already loads, so every user gets it instantly with no LLM cost.
 *   - The EXPLANATION is the paid product. Each insight carries a `coachPrompt`
 *     that seeds a Coach Drona chat ("why is this happening, how do I fix it") —
 *     tapping a card funnels the user into the coach (and, for free users, the
 *     paywall gate that owns the modal body).
 *
 * Everything here is a pure function of the workout list. No React, no network.
 * The same rules can later move into a `get_user_insights()` Postgres RPC so a
 * scheduled job can push the top insight as a notification — keep the thresholds
 * below as the single source of truth when that happens.
 *
 * Precision over recall. A wrong "you've plateaued" erodes trust faster than a
 * missed one, so each detector is conservative: it needs enough sessions to be
 * sure, surfaces only the single worst case per category, and the final list is
 * ranked and capped. Heuristic claims (recovery, deloads) are deliberately left
 * to Drona — here we only assert what the data unambiguously shows.
 */

export type InsightType = 'victory' | 'plateau' | 'warning' | 'suggestion';

export interface Insight {
  /**
   * Stable identity for dedupe + dismissal. Encodes the subject and a time
   * bucket (usually the ISO week) so a dismissed insight re-surfaces if the
   * condition still holds next week, but stays gone for the rest of this one.
   */
  id: string;
  type: InsightType;
  /** Optional Feather icon override; the card supplies a sensible default per type. */
  icon?: string;
  /** Optional kicker override (e.g. "BENCH PLATEAU"); card defaults per type otherwise. */
  kicker?: string;
  /** The "what" — short and bold. One line. */
  title: string;
  /** The "why"/detail — one or two lines, plain language. */
  body: string;
  /** First-person question that seeds the Coach Drona chat when the card is tapped. */
  coachPrompt: string;
  /** Higher = nearer the front of the strip. */
  priority: number;
  /**
   * Muscle this insight is "about", if any. Used to de-dupe the strip so the
   * user never sees two cards about the same muscle (e.g. an imbalance and a
   * low-volume tip both about Chest, which reads as contradictory).
   */
  subject?: string;
}

// ─── Input shape ─────────────────────────────────────────────────────────────
// Mirrors exactly what the dashboard already has in `workouts` (normalized so
// `sets` is the joined workout_sets rows). Read defensively — same field
// fallbacks the dashboard uses (s.exercises?.muscle_group || s.muscle_group).

export interface InsightSet {
  completed?: boolean;
  weight_kg?: number;
  reps?: number;
  exercise_id?: string;
  muscle_group?: string;
  exercises?: { id?: string; name?: string; muscle_group?: string } | null;
}

export interface InsightWorkout {
  id: string;
  name?: string;
  started_at: string;
  duration_seconds?: number | null;
  total_volume_kg?: number | null;
  routine_id?: string | null;
  sets?: InsightSet[];
}

export interface DetectInsightsInput {
  workouts: InsightWorkout[];
  /** Defaults to now; injectable for tests / a future server job. */
  now?: Date;
}

// ─── Training-science thresholds (documented heuristics) ─────────────────────
// Weekly sets per muscle group. ~10 sets/wk is the rough productive floor for a
// major muscle; 10–20 the working range; past ~22 returns diminish for most
// trainees. Smaller muscles get lower floors. These are mainstream landmarks,
// not gospel — phrased as "looks low / consider" in copy, never as absolutes.
const MAJOR_MUSCLES = new Set(['Chest', 'Back', 'Quads', 'Hamstrings', 'Shoulders', 'Glutes']);
const MINOR_MUSCLES = new Set(['Biceps', 'Triceps', 'Calves', 'Core']);
const FLOOR_MAJOR = 10;
const FLOOR_MINOR = 6;

// Antagonist / push-pull pairs we check for lopsided development.
const BALANCE_PAIRS: { a: string; b: string }[] = [
  { a: 'Chest', b: 'Back' },
  { a: 'Quads', b: 'Hamstrings' },
];
const IMBALANCE_RATIO = 2.0; // larger side ≥ 2× the other (and enough total volume)

const STALL_MIN_SESSIONS = 5;       // need history before calling a plateau
const STALL_SESSIONS_SINCE_PR = 4;  // sessions since last improvement
const STALL_MIN_SPAN_DAYS = 14;     // …spread over at least this long
const RECENT_LIFT_DAYS = 21;        // only flag lifts they're currently training
const INACTIVITY_DAYS = 4;          // gentle "you've been away" nudge
const STREAK_MILESTONES = [100, 50, 30, 14, 7];

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function epley1RM(weightKg: number, reps: number): number {
  return weightKg * (1 + reps / 30);
}

function muscleOf(s: InsightSet): string | undefined {
  return s.exercises?.muscle_group || s.muscle_group || undefined;
}

function exIdOf(s: InsightSet): string | undefined {
  return s.exercise_id || s.exercises?.id || undefined;
}

/** ISO-week stamp like "2026-W22" — the dismissal time bucket. */
function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Sum of completed sets touching a muscle within [now - days, now]. */
function setsForMuscleInWindow(
  workouts: InsightWorkout[], muscle: string, now: Date, days: number,
): number {
  const cutoff = now.getTime() - days * DAY_MS;
  let count = 0;
  for (const w of workouts) {
    if (new Date(w.started_at).getTime() < cutoff) continue;
    for (const s of w.sets || []) {
      if (s.completed === false) continue;
      if (muscleOf(s) === muscle) count++;
    }
  }
  return count;
}

interface SessionBest { date: Date; best1rm: number; }

/**
 * Per-exercise series of each session's best Epley 1RM, oldest → newest, plus
 * the exercise's display name and muscle. Only completed sets with real load.
 */
function buildExerciseSeries(workouts: InsightWorkout[]) {
  const sorted = [...workouts].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );
  const series = new Map<string, { name: string; muscle?: string; sessions: SessionBest[] }>();
  for (const w of sorted) {
    const perEx = new Map<string, number>(); // exId -> best 1rm this session
    const meta = new Map<string, { name: string; muscle?: string }>();
    for (const s of w.sets || []) {
      if (s.completed === false) continue;
      const exId = exIdOf(s);
      const name = s.exercises?.name;
      if (!exId || !name) continue;
      const weight = s.weight_kg ?? 0;
      const reps = s.reps ?? 0;
      if (weight <= 0 || reps <= 0) continue;
      const e = epley1RM(weight, reps);
      if (e > (perEx.get(exId) ?? 0)) perEx.set(exId, e);
      if (!meta.has(exId)) meta.set(exId, { name, muscle: muscleOf(s) });
    }
    for (const [exId, best1rm] of perEx) {
      let entry = series.get(exId);
      if (!entry) {
        const m = meta.get(exId)!;
        entry = { name: m.name, muscle: m.muscle, sessions: [] };
        series.set(exId, entry);
      }
      entry.sessions.push({ date: new Date(w.started_at), best1rm });
    }
  }
  return series;
}

// ─── Detectors ───────────────────────────────────────────────────────────────

/** New all-time Epley peaks in the last 7 days → a celebratory victory. */
function detectRecentPRs(
  series: ReturnType<typeof buildExerciseSeries>, now: Date,
): Insight | null {
  const since = now.getTime() - 7 * DAY_MS;
  const prNames: string[] = [];
  for (const [, entry] of series) {
    let runningMax = 0;
    let prThisWeek = false;
    for (const s of entry.sessions) {
      // Strictly-greater AND not the very first datapoint = a genuine PR.
      if (runningMax > 0 && s.best1rm > runningMax && s.date.getTime() >= since) {
        prThisWeek = true;
      }
      if (s.best1rm > runningMax) runningMax = s.best1rm;
    }
    if (prThisWeek) prNames.push(entry.name);
  }
  if (prNames.length === 0) return null;

  const multi = prNames.length >= 2;
  return {
    id: `pr:${isoWeek(now)}`,
    type: 'victory',
    icon: 'award',
    kicker: 'NEW PR',
    title: multi ? `${prNames.length} new PRs this week` : `New PR: ${prNames[0]}`,
    body: multi
      ? `Personal bests on ${prNames.slice(0, 3).join(', ')}${prNames.length > 3 ? ' and more' : ''}. Momentum's on your side.`
      : `You beat your best estimated 1RM on ${prNames[0]}. Nice work.`,
    coachPrompt: multi
      ? `I just set new PRs on ${prNames.slice(0, 3).join(', ')} this week. What's driving the progress and what should I focus on to keep it going?`
      : `I just hit a new PR on ${prNames[0]}. How do I keep progressing on it without stalling or getting hurt?`,
    priority: 70 + Math.min(prNames.length, 3) * 4,
  };
}

/** A current lift that hasn't beaten its peak in several sessions → plateau. */
function detectStalls(
  series: ReturnType<typeof buildExerciseSeries>,
  workouts: InsightWorkout[],
  now: Date,
): Insight[] {
  const candidates: { insight: Insight; sessions: number }[] = [];

  for (const [, entry] of series) {
    const ss = entry.sessions;
    if (ss.length < STALL_MIN_SESSIONS) continue;
    const last = ss[ss.length - 1];
    if (now.getTime() - last.date.getTime() > RECENT_LIFT_DAYS * DAY_MS) continue; // not a current lift

    // Index of the last session that improved on everything before it.
    let runningMax = 0;
    let improveIdx = 0;
    ss.forEach((s, i) => {
      if (s.best1rm > runningMax) { runningMax = s.best1rm; improveIdx = i; }
    });
    const sessionsSincePR = ss.length - 1 - improveIdx;
    const spanDays = (last.date.getTime() - ss[improveIdx].date.getTime()) / DAY_MS;
    if (sessionsSincePR < STALL_SESSIONS_SINCE_PR || spanDays < STALL_MIN_SPAN_DAYS) continue;

    // Probable cause: did volume for this muscle drop recently? (the "why")
    let cause = '';
    if (entry.muscle) {
      const recent = setsForMuscleInWindow(workouts, entry.muscle, now, 21) / 3;
      const prior = setsForMuscleInWindow(
        workouts, entry.muscle,
        new Date(now.getTime() - 21 * DAY_MS), 21,
      ) / 3;
      if (prior >= 1 && recent < prior * 0.75) {
        cause = ` Your ${entry.muscle.toLowerCase()} volume also dropped from ~${Math.round(prior)} to ~${Math.round(recent)} sets/week — likely related.`;
      }
    }

    candidates.push({
      sessions: ss.length,
      insight: {
        id: `stall:${entry.name}:${isoWeek(now)}`,
        type: 'plateau',
        icon: 'bar-chart-2',
        kicker: 'PLATEAU',
        title: `${entry.name} has stalled`,
        body: `No new best in ${sessionsSincePR} sessions.${cause || ' Worth a look at load, volume, or recovery.'}`,
        coachPrompt: `My ${entry.name} hasn't improved in ${sessionsSincePR} sessions. Based on my training history, why might it be stalling and how do I break through the plateau?`,
        priority: 80 + Math.min(sessionsSincePR, 6),
      },
    });
  }

  // Surface at most the two most-trained stalled lifts (likely the compounds
  // the user actually cares about), not every accessory.
  return candidates
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 2)
    .map(c => c.insight);
}

/** The single most under-stimulated muscle they're currently training → tip. */
function detectLowVolume(workouts: InsightWorkout[], now: Date): Insight | null {
  let worst: { muscle: string; avg: number; floor: number; deficit: number } | null = null;
  for (const muscle of [...MAJOR_MUSCLES, ...MINOR_MUSCLES]) {
    const trained28 = setsForMuscleInWindow(workouts, muscle, now, 28);
    if (trained28 < 1) continue; // not part of their plan — don't nag
    const avg = setsForMuscleInWindow(workouts, muscle, now, 21) / 3;
    const floor = MAJOR_MUSCLES.has(muscle) ? FLOOR_MAJOR : FLOOR_MINOR;
    if (avg <= 0 || avg >= floor) continue;
    const deficit = (floor - avg) / floor;
    if (!worst || deficit > worst.deficit) worst = { muscle, avg, floor, deficit };
  }
  if (!worst) return null;

  return {
    id: `lowvol:${worst.muscle}:${isoWeek(now)}`,
    type: 'suggestion',
    icon: 'trending-up',
    kicker: 'TIP',
    title: `${worst.muscle} volume looks low`,
    body: `About ${worst.avg.toFixed(0)} sets/week — under the ~${worst.floor}-set range most people need to grow it.`,
    coachPrompt: `I'm only averaging about ${worst.avg.toFixed(0)} sets of ${worst.muscle.toLowerCase()} per week. Is that enough for my goal, and how should I add volume without overloading my schedule?`,
    priority: 60 + Math.round(worst.deficit * 12),
    subject: worst.muscle,
  };
}

/** A lopsided antagonist pair (e.g. chest ≫ back) → heads-up warning. */
function detectImbalance(workouts: InsightWorkout[], now: Date): Insight | null {
  let worst: { big: string; small: string; ratio: number } | null = null;
  for (const { a, b } of BALANCE_PAIRS) {
    const av = setsForMuscleInWindow(workouts, a, now, 28);
    const bv = setsForMuscleInWindow(workouts, b, now, 28);
    const [big, small, bigV, smallV] = av >= bv ? [a, b, av, bv] : [b, a, bv, av];
    if (bigV < 8) continue; // not enough signal to judge
    // Require the smaller side to be genuinely trained too. Otherwise this is
    // neglect of one muscle (or just sparse data), not an imbalance to
    // rebalance — and an "8× as much" ratio off a near-zero denominator reads
    // as nonsense. Precision over recall.
    if (smallV < 4) continue;
    const ratio = bigV / Math.max(smallV, 1);
    if (ratio < IMBALANCE_RATIO) continue;
    if (!worst || ratio > worst.ratio) worst = { big, small, ratio };
  }
  if (!worst) return null;

  return {
    id: `imbalance:${worst.big}-${worst.small}:${isoWeek(now)}`,
    type: 'warning',
    icon: 'alert-triangle',
    kicker: 'HEADS UP',
    title: `${worst.big} is outpacing ${worst.small}`,
    body: `You're training ${worst.big.toLowerCase()} about ${worst.ratio.toFixed(1)}× as much as ${worst.small.toLowerCase()}. Imbalances can hurt posture and progress.`,
    coachPrompt: `My ${worst.big.toLowerCase()} volume is roughly ${worst.ratio.toFixed(1)}× my ${worst.small.toLowerCase()} volume. Should I rebalance to avoid injury or postural issues, and how would you adjust my split?`,
    priority: 75 + Math.min(Math.round(worst.ratio), 6),
    subject: worst.big,
  };
}

/** Several days since the last session → gentle re-engagement nudge. */
function detectInactivity(workouts: InsightWorkout[], now: Date): Insight | null {
  if (workouts.length === 0) return null;
  const last = workouts.reduce(
    (m, w) => Math.max(m, new Date(w.started_at).getTime()), 0,
  );
  const days = Math.floor((now.getTime() - last) / DAY_MS);
  if (days < INACTIVITY_DAYS || days >= 30) return null; // 30+ is "comeback", out of scope for v1

  return {
    id: `inactive:${isoWeek(now)}`,
    type: 'warning',
    icon: 'clock',
    kicker: 'HEADS UP',
    title: `${days} days since your last workout`,
    body: `Consistency drives results more than any single session. Want help easing back in?`,
    coachPrompt: `I haven't trained in ${days} days. How do I get back into it without overdoing the first session, and how can I stay consistent?`,
    priority: 72 + Math.min(days, 8),
  };
}

/** Consecutive-day streak crossing a milestone → victory. */
function detectStreakMilestone(workouts: InsightWorkout[], now: Date): Insight | null {
  const days = new Set(workouts.map(w => new Date(w.started_at).toDateString()));
  let streak = 0;
  const cursor = new Date(now);
  for (let i = 0; i < 400; i++) {
    if (days.has(cursor.toDateString())) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else if (i === 0) {
      cursor.setDate(cursor.getDate() - 1); // today not logged yet — don't break the streak
    } else break;
  }
  const milestone = STREAK_MILESTONES.find(m => streak >= m);
  if (!milestone) return null;

  return {
    // Stamped by milestone (not week) so it shows once per milestone reached.
    id: `streak:${milestone}`,
    type: 'victory',
    icon: 'zap',
    kicker: 'STREAK',
    title: `${streak}-day streak 🔥`,
    body: `You've trained ${milestone}+ days in a row. That consistency is exactly what builds long-term progress.`,
    coachPrompt: `I'm on a ${streak}-day training streak. How do I keep this momentum while making sure I'm recovering enough?`,
    priority: 68 + Math.min(Math.floor(milestone / 10), 6),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run every detector, rank by priority, and cap the strip. Returns [] when
 * there's nothing worth surfacing (new users, quiet weeks) — the UI renders
 * nothing in that case rather than an empty shell.
 */
export function detectInsights(input: DetectInsightsInput): Insight[] {
  const { workouts } = input;
  const now = input.now ?? new Date();
  if (!workouts || workouts.length === 0) return [];

  const series = buildExerciseSeries(workouts);

  const found: Insight[] = [
    detectRecentPRs(series, now),
    ...detectStalls(series, workouts, now),
    detectLowVolume(workouts, now),
    detectImbalance(workouts, now),
    detectInactivity(workouts, now),
    detectStreakMilestone(workouts, now),
  ].filter((i): i is Insight => i !== null);

  // De-dupe by subject muscle (keep the highest-priority card per muscle) so
  // the strip never shows two cards about the same muscle. Subject-less
  // insights (PRs, streaks, inactivity) are always kept.
  const ranked = found.sort((a, b) => b.priority - a.priority);
  const seenSubjects = new Set<string>();
  const deduped = ranked.filter((i) => {
    if (!i.subject) return true;
    if (seenSubjects.has(i.subject)) return false;
    seenSubjects.add(i.subject);
    return true;
  });
  return deduped.slice(0, 5);
}
