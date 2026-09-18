/**
 * Which card Drona shows this week, from the counts in get_drona_facts.
 *
 * Three steps, in order (plan: .planning/drona-cards-plan.md):
 *   behaviours  the counts, already read from the database
 *   signals     what each count means, with a coverage gate: too little data
 *               is `unknown`, never `false`
 *   rules       the first case that fires wins, and most weeks nothing does
 *
 * P0 decides only the cheap kinds: a request (do this, it is worth it), a
 * notice (I am reading, not changing anything), or a hold (say nothing). Act
 * and talk cards come with the model in P1, inside these same gates.
 *
 * Pure: no imports, no network, no Date. Unit-tested in dronaCards.test.ts.
 */

export interface DronaFacts {
  as_of?: string;
  week_start?: string;
  timezone?: string | null;
  tier?: string | null;
  tenure?: {
    joined_on?: string | null;
    days_since_joined?: number | null;
    first_session_on?: string | null;
    days_since_first_session?: number | null;
    sessions_total?: number | null;
  };
  goal?: {
    goal?: string | null;
    detail?: string | null;
    weight_kg?: number | null;
    goal_weight_kg?: number | null;
    program_goal?: string | null;
    target_weight_kg?: number | null;
  };
  program?: { id?: string; phase_id?: string | null } | null;
  training?: {
    sessions_14d?: number | null;
    planned_14d?: number | null;
    off_plan_14d?: number | null;
    days_since_last_session?: number | null;
  };
  nutrition?: {
    days_logged_14d?: number | null;
    target_kcal?: number | null;
    on_target_days_14d?: number | null;
  };
  weight?: { weigh_ins_14d?: number | null; weigh_ins_28d?: number | null };
  recovery?: { readiness_days_14d?: number | null };
  cards?: { week_start?: string; kind?: string; topic?: string; status?: string }[];
}

/** A signal is true, false, or unknown when the data cannot answer it. */
export type Signal = boolean | 'unknown';

export interface DronaSignals {
  /** Too new to judge: no sessions yet, under 14 days in, or under 6 sessions. */
  new_user: boolean;
  /** The goal is about a number on a scale, so weigh-ins matter. */
  weight_goal: boolean;
  /** No weigh-in at all in 28 days. */
  weight_none: Signal;
  /** Fewer than 6 weigh-ins in 14 days: too thin to read a trend. */
  weight_sparse: Signal;
  food_none: Signal;
  /** Fewer than 9 of 14 days logged. */
  food_sparse: Signal;
  /** Trained, but under 60% of what the plan asked for. */
  sessions_missed: Signal;
  /** A week or more since the last session. */
  no_training: Signal;
}

const n = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const NEW_USER_DAYS = 14;
const NEW_USER_SESSIONS = 6;
const WEIGH_INS_FOR_A_TREND = 6;
const FOOD_DAYS_FOR_A_READ = 9;
const MISSED_FRACTION = 0.6;
const NO_TRAINING_DAYS = 7;

/** Goals that are read off a scale. Anything else does not need weigh-ins. */
const WEIGHT_GOALS = ['fat_loss', 'weight_loss', 'lose_weight', 'cut', 'muscle_gain', 'gain_weight', 'bulk', 'recomp'];

export function signalsFrom(facts: DronaFacts): DronaSignals {
  const sessionsTotal = n(facts.tenure?.sessions_total) ?? 0;
  const daysSinceFirst = n(facts.tenure?.days_since_first_session);
  const newUser = daysSinceFirst == null || daysSinceFirst < NEW_USER_DAYS || sessionsTotal < NEW_USER_SESSIONS;

  const goal = (facts.goal?.program_goal ?? facts.goal?.goal ?? '').toLowerCase();
  const weightGoal = WEIGHT_GOALS.includes(goal)
    || n(facts.goal?.target_weight_kg) != null
    || n(facts.goal?.goal_weight_kg) != null;

  const weighIns14 = n(facts.weight?.weigh_ins_14d);
  const weighIns28 = n(facts.weight?.weigh_ins_28d);
  const foodDays = n(facts.nutrition?.days_logged_14d);
  const hasTargets = n(facts.nutrition?.target_kcal) != null;

  const planned = n(facts.training?.planned_14d) ?? 0;
  const sessions14 = n(facts.training?.sessions_14d);
  const daysSinceLast = n(facts.training?.days_since_last_session);

  return {
    new_user: newUser,
    weight_goal: weightGoal,
    weight_none: weighIns28 == null ? 'unknown' : weighIns28 === 0,
    weight_sparse: weighIns14 == null ? 'unknown' : weighIns14 < WEIGH_INS_FOR_A_TREND,
    food_none: !hasTargets ? 'unknown' : foodDays == null ? 'unknown' : foodDays === 0,
    // Both food signals need targets: with none set, the app cannot say what
    // intake should be, and asking someone to log is noise, not help.
    food_sparse: !hasTargets || foodDays == null ? 'unknown' : foodDays < FOOD_DAYS_FOR_A_READ,
    // Needs a plan to miss: with no planned sessions there is nothing to be behind on.
    sessions_missed: planned <= 0 || sessions14 == null
      ? 'unknown'
      : sessions14 > 0 && sessions14 < planned * MISSED_FRACTION,
    no_training: daysSinceLast == null ? 'unknown' : daysSinceLast >= NO_TRAINING_DAYS,
  };
}

/**
 * The Monday of a local day's week, as YYYY-MM-DD. The worker and the facts
 * function must agree on this: two definitions would give one user two cards in
 * a week, or none. Built from the date parts only, so no zone or DST shift can
 * move it.
 */
export function weekStartOf(localDay: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDay ?? '');
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const weekday = new Date(utc).getUTCDay(); // 0 Sunday .. 6 Saturday
  const back = (weekday + 6) % 7; // days since Monday
  return new Date(utc - back * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from one YYYY-MM-DD to another, or null when unreadable. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

/**
 * The card the phone should show, from the user's newest cards.
 *
 * The SERVER decides which week a card belongs to, from the time zone saved on
 * the profile. The phone must not re-derive it from its own clock: after a
 * flight the two disagree around Sunday midnight, and the phone would look for
 * a week the server never wrote (and ask for a second card). So the phone takes
 * the newest card whose week is within 7 days either side of its own week, and
 * treats "none in that window" as the only reason to ask for one.
 *
 * Returns the card (whatever its status) or null. `rows` newest first or not.
 */
export function pickCurrentCard<T extends { week_start: string }>(rows: T[] | null | undefined, deviceDay: string): T | null {
  const deviceWeek = weekStartOf(deviceDay);
  if (!deviceWeek) return null;
  let best: T | null = null;
  for (const row of rows ?? []) {
    const gap = daysBetween(deviceWeek, row?.week_start ?? '');
    if (gap == null || Math.abs(gap) > 7) continue;
    if (!best || row.week_start > best.week_start) best = row;
  }
  return best;
}

/**
 * Where a card's button goes, by its action. The phone maps the action itself
 * rather than trusting a stored route, so a renamed screen can never strand a
 * card that was written before the rename.
 */
export const ACTION_ROUTES: Record<string, string> = {
  log_weight: '/(app)/analytics',
  log_food: '/(app)/nutrition',
  // start_session has no route: the dashboard opens today's session preview.
};

export type CardKind = 'request' | 'notice' | 'hold';

export interface DronaCard {
  kind: CardKind;
  topic: string;
  title: string;
  body: string;
  /** The numbers the card rests on, shown as chips so the user can check them. */
  evidence: { label: string; value: string }[];
  /** Where the button goes, and what it asks for. Empty for a notice. */
  payload: { action?: string; route?: string };
  signals: string[];
}

const COOLDOWN_WEEKS = 2;
const DISMISSED_COOLDOWN_WEEKS = 4;

/** Whole weeks between two Mondays (YYYY-MM-DD), or null when unreadable. */
function weeksBetween(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / (7 * 86_400_000));
}

/**
 * Has this topic been shown too recently? A card repeats at most every two
 * weeks, and a dismissed one waits four: asking again straight away is how a
 * helpful nudge turns into nagging.
 */
export function onCooldown(topic: string, facts: DronaFacts): boolean {
  for (const card of facts.cards ?? []) {
    if (card.topic !== topic) continue;
    const weeks = weeksBetween(card.week_start, facts.week_start);
    if (weeks == null) continue;
    const limit = card.status === 'dismissed' ? DISMISSED_COOLDOWN_WEEKS : COOLDOWN_WEEKS;
    if (weeks < limit) return true;
  }
  return false;
}

const on = (s: Signal): boolean => s === true;

/**
 * The card for this week, or a hold. The first case that fires wins; a topic
 * on cooldown is skipped and the next case gets its turn.
 */
export function decideCard(facts: DronaFacts, signals: DronaSignals = signalsFrom(facts)): DronaCard {
  const t = facts.training ?? {};
  const w = facts.weight ?? {};
  const f = facts.nutrition ?? {};
  const days = n(t.days_since_last_session);
  const planned = n(t.planned_14d) ?? 0;
  const sessions = n(t.sessions_14d) ?? 0;

  const candidates: DronaCard[] = [];

  if (signals.new_user) {
    candidates.push({
      kind: 'notice',
      topic: 'watching',
      title: 'I am reading, not steering',
      body: 'You are new here. I am watching how your body answers the work before I change anything.',
      evidence: [{ label: 'Sessions so far', value: String(n(facts.tenure?.sessions_total) ?? 0) }],
      payload: {},
      signals: ['new_user'],
    });
  } else {
    if (on(signals.no_training)) {
      candidates.push({
        kind: 'request',
        topic: 'due_session',
        title: 'Your plan is waiting',
        body: 'One session this week puts the block back in motion. Start with what is due.',
        evidence: [{ label: 'Days since your last session', value: String(days ?? 0) }],
        payload: { action: 'start_session' },
        signals: ['no_training'],
      });
    }
    if (signals.weight_goal && on(signals.weight_none)) {
      candidates.push({
        kind: 'request',
        topic: 'weigh_in',
        title: 'Step on the scale this week',
        body: 'Your goal is a number on the scale. Three mornings is enough for me to read where it is going.',
        evidence: [{ label: 'Weigh-ins in 28 days', value: String(n(w.weigh_ins_28d) ?? 0) }],
        payload: { action: 'log_weight', route: '/(app)/analytics' },
        signals: ['weight_goal', 'weight_none'],
      });
    }
    if (on(signals.food_none)) {
      candidates.push({
        kind: 'request',
        topic: 'log_food',
        title: 'Log what you eat for a few days',
        body: 'Without food days I cannot tie the scale to your intake. Five days this week is plenty.',
        evidence: [{ label: 'Days logged in 14', value: String(n(f.days_logged_14d) ?? 0) }],
        payload: { action: 'log_food', route: '/(app)/nutrition' },
        signals: ['food_none'],
      });
    }
    if (signals.weight_goal && on(signals.weight_sparse)) {
      candidates.push({
        kind: 'request',
        topic: 'weigh_in',
        title: 'A few more weigh-ins',
        body: 'Daily weight jumps with water and food. Three mornings a week and the trend gets honest.',
        evidence: [{ label: 'Weigh-ins in 14 days', value: String(n(w.weigh_ins_14d) ?? 0) }],
        payload: { action: 'log_weight', route: '/(app)/analytics' },
        signals: ['weight_goal', 'weight_sparse'],
      });
    }
    if (on(signals.food_sparse)) {
      candidates.push({
        kind: 'request',
        topic: 'log_food',
        title: 'Log food a little more often',
        body: 'A few more days and I can tell whether your intake is moving the scale, or your logging is.',
        evidence: [{ label: 'Days logged in 14', value: String(n(f.days_logged_14d) ?? 0) }],
        payload: { action: 'log_food', route: '/(app)/nutrition' },
        signals: ['food_sparse'],
      });
    }
    if (on(signals.sessions_missed)) {
      candidates.push({
        kind: 'request',
        topic: 'due_session',
        title: 'The week is running ahead of you',
        body: 'You are under what the plan asked for. Take the session that is due, and let the rest go.',
        evidence: [
          { label: 'Sessions in 14 days', value: String(sessions) },
          { label: 'Plan asked for', value: String(planned) },
        ],
        payload: { action: 'start_session' },
        signals: ['sessions_missed'],
      });
    }
  }

  for (const card of candidates) {
    if (!onCooldown(card.topic, facts)) return card;
  }
  return {
    kind: 'hold',
    topic: 'hold',
    title: '',
    body: '',
    evidence: [],
    payload: {},
    signals: candidates.length > 0 ? ['cooldown'] : [],
  };
}
