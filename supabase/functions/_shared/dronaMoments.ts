/**
 * Drona moments (.planning/drona-moments.md): a card about something that just
 * happened, made as soon as it is found. The weekly card keeps the slow
 * patterns; a moment speaks the day it matters.
 *
 *   hurting             right after the message that says it (ai-coach)
 *   asked_for_a_change  the day after an ask the plan did not follow
 *   missed_sessions     the morning after two planned gaps without a session
 *   food_off            the morning after 3 whole days 25% off target
 *   pr                  right after a workout with a weight PR
 *
 * The database finds the candidates (get_drona_moment_candidates); this file
 * picks at most one and writes its words. So Drona does not nag: one moment a
 * day, three a week (pain is never held back by these), nothing on the day a
 * weekly card is still waiting (pain again excepted), each topic on the usual
 * cooldown (2 weeks, 4 after "Skip"), 'topic:' mutes and the quiet week obeyed.
 *
 * Pure: no network, no clock (days come in as YYYY-MM-DD). Tested in
 * dronaMoments.test.ts.
 */
import { hushed, type PickCard, WORDS } from './dronaPick.ts';
import { weekStartOf } from './dronaCards.ts';

export type MomentType = 'hurting' | 'asked_for_a_change' | 'missed_sessions' | 'food_off' | 'pr';

export interface MomentCandidate {
  type: MomentType;
  detail: Record<string, unknown>;
}

export interface MomentCardRow {
  slot: string;
  topic: string;
  status: string;
  moment_day?: string | null;
  created_day?: string | null;
  deferred?: boolean;
}

/** One row of get_drona_moment_candidates (pain adds its own candidate). */
export interface MomentPerson {
  user_id: string;
  today: string;
  candidates: MomentCandidate[];
  cards: MomentCardRow[];
  mutes?: string[] | null;
  hushed?: boolean;
}

/** Most important first. */
const PRIORITY: Record<MomentType, number> = { hurting: 0, asked_for_a_change: 1, missed_sessions: 2, food_off: 3, pr: 4 };
export const DAY_CAP = 1;
export const WEEK_CAP = 3;
/** A moment is about now: unopened, it expires after this long. */
export const MOMENT_HOURS = 48;
const COOLDOWN_DAYS = 14;
const DISMISSED_COOLDOWN_DAYS = 28;
/**
 * A PR is good news and the workout id already stops repeats: a short wait, so
 * someone setting bests often still hears about them (not every one).
 */
const PR_COOLDOWN_DAYS = 3;
const PR_DISMISSED_COOLDOWN_DAYS = 7;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const kg = (n: number) => String(Math.round(n * 10) / 10);
function daysBetween(from: string | null | undefined, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

type Words = Omit<PickCard, 'signals' | 'topic'> | null;

function missedSessions(d: Record<string, unknown>): Words {
  const gap = num(d.gap_days);
  if (gap == null) return null;
  const seen = `No session for ${gap} days.`;
  return {
    kind: 'talk',
    title: `${gap} days since your last session`,
    body: `${seen} That happens. Want to pick up with today's session, or make this week lighter?`,
    quiet: seen,
    evidence: [{ label: 'Days since your last session', value: String(gap) }],
    payload: {
      action: 'talk',
      prompt: `I have not trained for ${gap} days. Help me get going again this week: today's session, or a lighter week?`,
    },
  };
}

function foodOff(d: Record<string, unknown>): Words {
  const pct = num(d.avg_pct);
  const over = d.direction === 'over';
  if (pct == null || (d.direction !== 'over' && d.direction !== 'under')) return null;
  const seen = `Your last three days averaged ${pct}% of your calorie target.`;
  return {
    kind: 'talk',
    title: over ? 'Three days well over target' : 'Three days well under target',
    body: over
      ? `${seen} Want to look at what is driving it?`
      : `${seen} Eating this far under can cost you muscle and energy. Want to look at it together?`,
    quiet: seen,
    evidence: [{ label: 'Of target, 3 days', value: `${pct}%` }],
    payload: {
      action: 'talk',
      prompt: `My last three days were about ${pct}% of my calorie target. Help me see what is driving it and what to change.`,
    },
  };
}

function pr(d: Record<string, unknown>): Words {
  const prs = (Array.isArray(d.prs) ? d.prs : []) as Record<string, unknown>[];
  const top = prs.find((p) => str(p?.exercise) && num(p?.weight_kg) != null && num(p?.prev_best_kg) != null);
  if (!top) return null;
  const name = str(top.exercise)!;
  const now = num(top.weight_kg)!;
  const before = num(top.prev_best_kg)!;
  const reps = num(top.reps);
  const set = `${kg(now)} kg${reps ? ` x ${reps}` : ''}`;
  const more = prs.length > 1 ? `${prs.length} new bests in one session. ` : '';
  const body = `${more}${name}: ${set}, up from ${kg(before)} kg. That is the work paying off.`;
  return {
    kind: 'notice',
    title: `New best: ${name}`,
    body,
    quiet: body,
    evidence: [{ label: 'New best', value: `${kg(now)} kg` }, { label: 'Before', value: `${kg(before)} kg` }],
    // The workout it came from: the database never makes a second card for it.
    payload: str(d.workout_id) ? { workout_id: str(d.workout_id)! } as PickCard['payload'] : {},
  };
}

/** The words for one moment, or null when its detail is too thin to say honestly. */
export function momentWords(c: MomentCandidate): Words {
  const d = c.detail ?? {};
  switch (c.type) {
    case 'hurting': return WORDS.hurting(d);
    case 'asked_for_a_change': return WORDS.asked_for_a_change(d);
    case 'missed_sessions': return missedSessions(d);
    case 'food_off': return foodOff(d);
    case 'pr': return pr(d);
    default: return null;
  }
}

/**
 * Shown, or skipped, too recently? Any slot counts: a weekly card on the same
 * topic waits it out too. Pain too, on purpose: one pain card per two weeks,
 * whatever the body part, so a person mentioning aches often is not told to
 * see a professional every week (the per-day unique index is only a backstop).
 */
function onCooldown(topic: string, cards: MomentCardRow[], today: string): boolean {
  return cards.some((c) => {
    if (c.topic !== topic) return false;
    const ago = daysBetween(c.created_day ?? c.moment_day, today);
    if (ago == null) return false;
    const pr = topic === 'pr';
    const limit = c.status === 'dismissed'
      ? (pr ? PR_DISMISSED_COOLDOWN_DAYS : DISMISSED_COOLDOWN_DAYS)
      : (pr ? PR_COOLDOWN_DAYS : COOLDOWN_DAYS);
    return ago < limit;
  });
}

/** The one moment to make for this person now, or null. */
export function decideMoment(p: MomentPerson): PickCard | null {
  const cards = p.cards ?? [];
  const muted = new Set((p.mutes ?? []).filter((m) => m.startsWith('topic:')).map((m) => m.slice(6)));
  const moments = cards.filter((c) => c.slot === 'moment' && c.topic !== 'hurting');
  const today = moments.filter((c) => daysBetween(c.created_day ?? c.moment_day, p.today) === 0).length;
  const week = moments.filter((c) => {
    const ago = daysBetween(c.created_day ?? c.moment_day, p.today);
    return ago != null && ago >= 0 && ago < 7;
  }).length;
  const weeklyWaiting = cards.some((c) =>
    c.slot === 'weekly' && c.status === 'pending' && !c.deferred && daysBetween(c.created_day, p.today) === 0
  );
  const meta = p.hushed ? [{ behaviour: 'not_hearing_drona', priority: 12, card_kind: 'notice', meta: true }] : [];

  // Most important first; within a type the newest (two PR workouts in two days: the latest best).
  const day = (c: MomentCandidate) => String(c.detail?.day ?? '');
  const ordered = [...(p.candidates ?? [])].sort((a, b) =>
    (PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9) || day(b).localeCompare(day(a)));
  for (const c of ordered) {
    const words = momentWords(c);
    if (!words) continue;
    const topic = c.type;
    if (muted.has(topic) || onCooldown(topic, cards, p.today)) continue;
    // Pain is never held back by the caps or a waiting weekly card.
    if (topic !== 'hurting' && (today >= DAY_CAP || week >= WEEK_CAP || weeklyWaiting)) return null;
    const card = hushed({ ...words, topic, signals: [`moment:${topic}`] } as PickCard, { behaviours: meta });
    if (card.kind === 'hold') continue;
    return card;
  }
  return null;
}

/** The candidate a decided moment came from (its detail goes into the card's facts). */
export function candidateFor(p: MomentPerson, card: PickCard): MomentCandidate | null {
  // The same choice decideMoment made: within a type, the newest.
  const same = (p.candidates ?? []).filter((c) => c.type === card.topic);
  return same.sort((a, b) => String(b.detail?.day ?? '').localeCompare(String(a.detail?.day ?? '')))[0] ?? null;
}

/** The drona_cards row for a moment. One per person, day and topic (a unique index). */
export function momentRow(
  userId: string, today: string, card: PickCard, candidate: MomentCandidate | null, source: 'cron' | 'reply', nowMs: number,
) {
  return {
    user_id: userId, week_start: weekStartOf(today) ?? today, slot: 'moment', moment_day: today,
    kind: card.kind, topic: card.topic, title: card.title, body: card.body, evidence: card.evidence,
    payload: card.payload, signals: card.signals, facts: { moment: candidate }, source,
    expires_at: new Date(nowMs + MOMENT_HOURS * 3_600_000).toISOString(),
  };
}

