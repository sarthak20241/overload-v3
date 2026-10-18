/**
 * The weekly Drona card from the behaviours (.planning/drona-cards-pick.md).
 *
 * The database judges ~20 behaviours per person per finished week
 * (drona_behaviours). This file picks the one to say this week and writes its
 * words. The numbers come from the behaviour's own detail, never from a model;
 * the coach model only speaks after the person taps "Talk it through", and the
 * opening line it gets carries the same numbers the card showed.
 *
 * Skipped, in this order of reading (best priority first):
 *   - meta rows (not_hearing_drona: it changes HOW the pick is said, below)
 *   - steer rows (they feed the next plan, never a card)
 *   - the calorie check-in's own behaviours (it has its own card slot)
 *   - a card topic shown lately (onCooldown: 2 weeks, 4 after "Skip")
 *   - a muted topic ('topic:<x>' mutes), by the card's topic or what it asks for
 *
 * With a meta row that week, the pick is said as a notice: the same words, no
 * ask, one "Got it".
 *
 * Pure: no network, no Date. Unit-tested in dronaPick.test.ts.
 */
import { type DronaFacts, onCooldown } from './dronaCards.ts';

export interface BehaviourRow {
  behaviour: string;
  priority: number;
  card_kind: string;
  meta?: boolean | null;
  mutes?: string[] | null;
  detail?: Record<string, unknown> | null;
}

/** get_drona_pick_facts: the finished week's behaviour rows. */
export interface PickFacts {
  week_start?: string;
  behaviours?: BehaviourRow[] | null;
}

export type PickKind = 'request' | 'notice' | 'talk';

export interface PickCard {
  kind: PickKind;
  topic: string;
  title: string;
  body: string;
  evidence: { label: string; value: string }[];
  /** talk: the opening line sent for the person when they tap "Talk it through". */
  payload: { action?: string; prompt?: string };
  signals: string[];
}

/** The calorie check-in owns these (slot 'calories', _shared/dronaEnergy.ts). */
export const CHECKIN_BEHAVIOURS = ['finding_maintenance', 'calories_off'];

/** What a card's button asks for, as the topic the older cards used, so a mute or a cooldown covers both. */
const ASKS: Record<string, string> = { log_weight: 'weigh_in', log_food: 'log_food', start_session: 'due_session' };

/** The pick cards that are always an ask, and the older topic they ask for. */
const PICK_ASKS: Record<string, string> = { scale_untrusted: 'weigh_in', logs_partial_days: 'log_food' };

// ── Formatting ───────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** 72.5 -> "72.5", 72 -> "72", 72.63 -> "72.6" */
const kg = (n: number) => String(Math.round(n * 10) / 10);
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const times = (n: number) => (n === 2 ? 'twice' : `${n} times`);

const GOAL_LABELS: Record<string, string> = {
  hypertrophy: 'build muscle',
  strength: 'get stronger',
  fat_loss: 'lose fat',
  endurance: 'build endurance',
  general: 'general fitness',
};

/** What a card topic asked for, in words, for topic_not_landing. */
const TOPIC_WORDS: Record<string, { asked: string; none: string }> = {
  weigh_in: { asked: 'weigh-ins', none: 'none came' },
  log_food: { asked: 'food logs', none: 'none came' },
  due_session: { asked: 'a session', none: 'it did not happen' },
};

// ── The words, one function per behaviour ────────────────────────────────────

type Words = Omit<PickCard, 'signals' | 'topic'> | null;

function scaleUntrusted(d: Record<string, unknown>): Words {
  const swing = num(d.typical_swing_kg);
  return {
    kind: 'request',
    title: 'Same scale, same mornings',
    body: `${swing != null ? `Your readings swing about ${kg(swing)} kg from one to the next. ` : ''}`
      + 'Weigh in after waking, on the same scale, and the trend gets honest.',
    evidence: swing != null ? [{ label: 'Typical swing', value: `${kg(swing)} kg` }] : [],
    payload: { action: 'log_weight' },
  };
}

function logsPartialDays(d: Record<string, unknown>): Words {
  const avg = num(d.avg_kcal);
  const target = num(d.target_kcal);
  const days = num(d.days_logged);
  const numbers = avg != null && target != null;
  return {
    kind: 'request',
    title: 'Log whole days, even rough ones',
    body: `${numbers ? `Your logged days average ${thousands(Math.round(avg!))} kcal against a ${thousands(Math.round(target!))} target. ` : ''}`
      + 'Part days hide what you really eat.',
    evidence: [
      ...(numbers ? [{ label: 'Average logged day', value: `${thousands(Math.round(avg!))} kcal` }] : []),
      ...(days != null ? [{ label: 'Days logged', value: String(days) }] : []),
    ],
    payload: { action: 'log_food' },
  };
}

/** One side of goals_unclear: "build muscle, hold at 72.5 kg". */
function goalSide(goal: unknown, goalKg: unknown, direction: unknown): string | null {
  const label = GOAL_LABELS[str(goal) ?? ''] ?? null;
  const k = num(goalKg);
  const weight = k == null ? null
    : direction === 'loss' ? `down to ${kg(k)} kg`
    : direction === 'gain' ? `up to ${kg(k)} kg`
    : direction === 'hold' ? `hold at ${kg(k)} kg`
    : `${kg(k)} kg`;
  const parts = [label, weight].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : null;
}

function goalsUnclear(d: Record<string, unknown>): Words {
  const profile = goalSide(d.profile_goal, d.profile_goal_kg, d.profile_direction);
  const program = goalSide(d.program_goal, d.program_target_kg, d.program_direction);
  if (!profile || !program) return null;
  const name = str(d.program);
  return {
    kind: 'talk',
    title: 'Your goal and your program disagree',
    body: `Your profile says: ${profile}. Your program${name ? `, ${name},` : ''} says: ${program}. Tell me which one is right.`,
    // Chips are big type made for numbers: the goal weights, when both are known.
    evidence: num(d.profile_goal_kg) != null && num(d.program_target_kg) != null
      ? [{ label: 'Profile goal', value: `${kg(num(d.profile_goal_kg)!)} kg` },
         { label: 'Program target', value: `${kg(num(d.program_target_kg)!)} kg` }]
      : [],
    payload: {
      action: 'talk',
      prompt: `My profile goal and my program do not agree. My profile says: ${profile}. My program says: ${program}. Help me pick the right one.`,
    },
  };
}

function driftingAway(d: Record<string, unknown>): Words {
  const done = (num(d.sessions) ?? 0) + (num(d.last_week_sessions) ?? 0);
  const planned = (num(d.planned) ?? 0) + (num(d.last_week_planned) ?? 0);
  if (planned <= 0) return null;
  return {
    kind: 'talk',
    title: 'Two quiet weeks',
    body: `${done === 0 ? 'No sessions for two weeks.' : `${done} of ${planned} planned sessions in two weeks.`} `
      + 'That happens. Tell me what got in the way, and we will make the plan fit your week.',
    evidence: [{ label: 'Sessions in 2 weeks', value: `${done} of ${planned}` }],
    payload: {
      action: 'talk',
      prompt: `I did ${done} of my ${planned} planned sessions in the last two weeks. Help me get back on track with a plan that fits my week.`,
    },
  };
}

function ownWay(d: Record<string, unknown>): Words {
  const muscles = (Array.isArray(d.muscles_left_out) ? d.muscles_left_out : [])
    .map(str).filter((m): m is string => !!m);
  const left = muscles.length ? list(muscles) : null;
  return {
    kind: 'talk',
    title: 'You train your own way',
    body: `Most days you pick your own session, not the one that is due.${left ? ` ${left} got left out.` : ''} `
      + 'Want a plan built around how you train?',
    evidence: [],
    payload: {
      action: 'talk',
      prompt: `I keep picking my own sessions instead of the one that is due${left ? `, and ${left} got left out` : ''}. Can you shape my plan around how I actually train?`,
    },
  };
}

const STALL: Record<string, { kind: PickKind; title: (l: string) => string; body: (l: string) => string; why: string }> = {
  real_plateau: {
    kind: 'talk',
    title: (l) => `${l} has stopped moving`,
    body: (l) => `${l} has not gone up in three weeks, and you are training enough. Time to change the stimulus.`,
    why: 'a real plateau: I am training enough',
  },
  expected_on_cut: {
    kind: 'notice',
    title: () => 'Holding strength on a cut',
    body: (l) => `${l} is holding while you cut. On a cut, holding strength is a win.`,
    why: 'the cut',
  },
  recovery: {
    kind: 'talk',
    title: (l) => `${l} is stuck, and sleep is short`,
    body: (l) => `${l} has not gone up in three weeks, and your sleep has been short. Recovery is the likely cause.`,
    why: 'short sleep',
  },
  under_fuelled: {
    kind: 'talk',
    title: (l) => `${l} is stuck, and protein is short`,
    body: (l) => `${l} has not gone up in three weeks, and protein has been short. Food is the first thing to fix.`,
    why: 'too little protein',
  },
  cant_tell: {
    kind: 'request',
    title: (l) => `${l} is stuck`,
    body: (l) => `${l} has not gone up in three weeks. With part-day food logs I cannot tell why. Log whole days this week.`,
    why: 'not clear yet',
  },
  inconsistent_training: {
    kind: 'talk',
    title: (l) => `${l} is stuck`,
    body: (l) => `${l} has not gone up in three weeks, and sessions have been missed. Consistency first.`,
    why: 'missed sessions',
  },
};

function liftStall(d: Record<string, unknown>): Words {
  const lifts = (Array.isArray(d.lifts) ? d.lifts : []) as Record<string, unknown>[];
  const first = lifts.find((l) => str(l?.exercise));
  const s = STALL[str(d.cause) ?? ''];
  if (!first || !s) return null;
  const name = str(first.exercise)!;
  const from = num(first.from_kg);
  const now = num(first.now_kg);
  return {
    kind: s.kind,
    title: s.title(name),
    body: s.body(name),
    evidence: from != null && now != null
      ? [{ label: 'Best max, 3 weeks ago', value: `${kg(from)} kg` }, { label: 'Best max now', value: `${kg(now)} kg` }]
      : [],
    payload: s.kind === 'talk'
      ? { action: 'talk', prompt: `My ${name} has not gone up in three weeks. You think the cause is ${s.why}. What should I change?` }
      : s.kind === 'request' ? { action: 'log_food' } : {},
  };
}

function planTooBig(d: Record<string, unknown>): Words {
  const planned = num(d.planned);
  const avg = num(d.avg_sessions);
  if (planned == null || avg == null) return null;
  const about = Math.round(avg);
  return {
    kind: 'talk',
    title: `The plan asks for ${planned}, you do about ${about}`,
    body: `Over the last 8 weeks you averaged ${kg(avg)} sessions a week. A ${about}-day plan you finish beats a ${planned}-day plan you half do.`,
    evidence: [{ label: 'Planned a week', value: String(planned) }, { label: 'Your average', value: kg(avg) }],
    payload: {
      action: 'talk',
      prompt: `My plan asks for ${planned} sessions a week, but I average about ${kg(avg)}. Should we make the plan fit what I actually do?`,
    },
  };
}

function exerciseSkipped(d: Record<string, unknown>): Words {
  const all = (Array.isArray(d.exercises) ? d.exercises : []) as Record<string, unknown>[];
  const named = all.filter((e) => str(e?.exercise));
  if (!named.length) return null;
  // The one skipped the most, by share of its planned sessions.
  const share = (e: Record<string, unknown>) => (num(e.skipped) ?? 0) / Math.max(1, num(e.planned) ?? 0);
  const top = [...named].sort((a, b) => share(b) - share(a))[0];
  const name = str(top.exercise)!;
  const more = named.length > 1 ? ` (and ${named.length - 1} more)` : '';
  const planned = num(top.planned);
  const skipped = num(top.skipped);
  const routine = top.why === 'routine_skip' && planned != null && skipped != null;
  return {
    kind: 'talk',
    title: `You keep skipping ${name}`,
    body: routine
      ? `You skipped ${name}${more} in ${skipped} of ${planned} sessions. Want something you will do instead?`
      : `${name}${more} is in your plan, and you have not done it this phase. Want something you will do instead?`,
    evidence: routine ? [{ label: 'Sessions skipped', value: `${skipped} of ${planned}` }] : [],
    payload: {
      action: 'talk',
      prompt: `I keep skipping ${name} in my plan. Can you suggest something I would actually do instead?`,
    },
  };
}

function topicNotLanding(d: Record<string, unknown>): Words {
  const topics = (Array.isArray(d.topics) ? d.topics : []) as Record<string, unknown>[];
  const t = topics.find((x) => TOPIC_WORDS[str(x?.topic) ?? '']);
  if (!t) return null;
  const w = TOPIC_WORDS[str(t.topic)!];
  const cards = num(t.cards) ?? 2;
  return {
    kind: 'talk',
    title: `I keep asking for ${w.asked}`,
    body: `I asked for ${w.asked} ${times(cards)}, and ${w.none}. I will leave it for now. `
      + 'If it does not fit your week, tell me, and we will find another way.',
    evidence: [{ label: 'Asked', value: String(cards) }],
    payload: {
      action: 'talk',
      prompt: `You keep asking me for ${w.asked}, and I have not done it. Let us find a way that fits my week.`,
    },
  };
}

function onTrack(d: Record<string, unknown>): Words {
  const sessions = num(d.sessions);
  const planned = num(d.planned);
  if (sessions == null || planned == null) return null;
  return {
    kind: 'notice',
    title: 'Right on plan',
    body: `${sessions} of ${planned} sessions last week. Keep going.`,
    evidence: [{ label: 'Sessions last week', value: `${sessions} of ${planned}` }],
    payload: {},
  };
}

/** Exported for the tests only. */
export const WORDS: Record<string, (d: Record<string, unknown>) => Words> = {
  scale_untrusted: scaleUntrusted,
  logs_partial_days: logsPartialDays,
  goals_unclear: goalsUnclear,
  drifting_away: driftingAway,
  own_way: ownWay,
  lift_stall: liftStall,
  plan_too_big: planTooBig,
  exercise_skipped: exerciseSkipped,
  topic_not_landing: topicNotLanding,
  on_track: onTrack,
};

/** The 'topic:<x>' mutes of the finished week, as a set of topics. */
export function mutedTopics(pf: PickFacts | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const row of pf?.behaviours ?? []) {
    for (const m of row?.mutes ?? []) if (typeof m === 'string' && m.startsWith('topic:')) out.add(m.slice(6));
  }
  return out;
}

/**
 * not_hearing_drona: two cards in a row went unanswered, so Drona backs off and
 * speaks in notices. decidePick does this for its own card; the worker passes
 * the P0 fallback's card through here too, so a hushed week never asks.
 */
export function hushed<C extends { kind: string; payload: object; signals: string[] }>(
  card: C,
  pf: PickFacts | null | undefined,
): C {
  const meta = (pf?.behaviours ?? []).some((r) => r?.meta === true);
  if (!meta || card.kind === 'notice' || card.kind === 'hold') return card;
  return { ...card, kind: 'notice', payload: {}, signals: [...card.signals, 'behaviour:not_hearing_drona'] };
}

/**
 * The older topics a pick card asked for lately (a pick card's topic is its
 * behaviour, so the P0 rules' cooldown would not see it). The worker adds
 * these to the P0 fallback's skip list, so "log whole days" is not followed by
 * "log food more often" the next week.
 */
export function askedLately(facts: DronaFacts): Set<string> {
  const out = new Set<string>();
  for (const [behaviour, asks] of Object.entries(PICK_ASKS)) if (onCooldown(behaviour, facts)) out.add(asks);
  return out;
}

/**
 * The weekly card from the behaviours, or null when none is left to say.
 * `facts` is get_drona_facts, read only for the cooldown (its recent weekly cards).
 */
export function decidePick(pf: PickFacts | null | undefined, facts: DronaFacts): PickCard | null {
  const rows = (pf?.behaviours ?? []).filter((r) => r && typeof r.behaviour === 'string');
  const muted = mutedTopics(pf);
  const ordered = rows
    .filter((r) => r.meta !== true && r.card_kind !== 'steer' && !CHECKIN_BEHAVIOURS.includes(r.behaviour))
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  for (const row of ordered) {
    const words = WORDS[row.behaviour]?.(row.detail ?? {});
    if (!words) continue;
    const topic = row.behaviour;
    const asks = ASKS[words.payload.action ?? ''];
    if (muted.has(topic) || (asks && muted.has(asks))) continue;
    if (onCooldown(topic, facts) || (asks && onCooldown(asks, facts))) continue;
    // Two cards in a row went unanswered: say it, ask nothing.
    return hushed({ ...words, topic, signals: [`behaviour:${row.behaviour}`] } as PickCard, pf);
  }
  return null;
}
