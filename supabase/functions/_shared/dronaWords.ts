/**
 * Drona's word behaviours (.planning/drona-word-behaviours.md).
 *
 * People tell Drona things. Four behaviours read those words:
 *   hurting              pain or an injury, now
 *   life_got_in_the_way  training dropped, and they said why
 *   trains_not_logging   they said they trained on a day with no session logged
 *   asked_for_a_change   they asked for a plan change, and nothing changed after
 *
 * Arithmetic in code, judgment in Jev. Code picks the texts, Jev answers one
 * yes/no (and a "which") per text and topic, and code decides with days,
 * sessions and plan changes. The answers become stored signals
 * (drona_word_signals), and the signals become behaviour rows that join the
 * weekly pick (_shared/dronaPick.ts writes the words).
 *
 * Pure: no imports but types, no network, no Date. Tested in dronaWords.test.ts;
 * the questions are measured in scripts/drona-words/eval.mts.
 */
import type { JevQuestion } from '../ai-coach/jev.ts';
import type { BehaviourRow } from './dronaPick.ts';

export interface WordText {
  id: string;
  kind: string;
  /** The local day it was written (YYYY-MM-DD). */
  day: string;
  context?: string | null;
  text: string;
}

export interface StoredSignal {
  signal: WordSignalName;
  fired: boolean;
  detail?: Record<string, unknown> | null;
}

/** get_drona_word_facts */
export interface WordFacts {
  week_start?: string;
  texts?: WordText[] | null;
  session_days?: string[] | null;
  sessions?: number | null;
  planned?: number | null;
  plan_changes?: { entity: string; source?: string | null; day: string }[] | null;
  prompts?: (string | null)[] | null;
  stored?: StoredSignal[] | null;
}

export const WORD_SIGNALS = ['hurting', 'life_got_in_the_way', 'trains_not_logging', 'asked_for_a_change'] as const;
export type WordSignalName = typeof WORD_SIGNALS[number];

/** At most this many texts a week go to Jev: the newest. */
export const MAX_TEXTS = 20;
/** A yes counts at this score or more. Near 0.5 Jev is a coin flip. */
export const YES = 0.75;

const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The texts to read: never the opening lines our own talk cards sent (Drona
 * must not read its own words back as theirs), at most the newest MAX_TEXTS.
 * The facts read already drops repeats and texts under 3 characters.
 */
export function chooseTexts(f: WordFacts | null | undefined): WordText[] {
  const ours = new Set((f?.prompts ?? []).map(norm).filter(Boolean));
  const texts = (f?.texts ?? [])
    .filter((t) => t && typeof t.text === 'string' && typeof t.day === 'string' && !ours.has(norm(t.text)));
  return texts.slice(-MAX_TEXTS);
}

const WHERE: Record<string, string> = {
  chat_message: 'a chat message to their coach',
  workout_note: 'a note on a logged workout',
  exercise_note: 'a note on one exercise in a workout',
  sticky_note: 'a standing note on an exercise',
  meal_note: 'a note on a meal',
};

/**
 * What Jev sees for one text: the text, where it was written, and up to two
 * earlier texts from the same day, so "it still hurts" can be read.
 */
export function stateFor(t: WordText, all: WordText[]): Record<string, unknown> {
  const i = all.indexOf(t);
  const earlier = all.slice(Math.max(0, i - 2), Math.max(0, i)).filter((e) => e.day === t.day).map((e) => e.text);
  return {
    text: t.text,
    written_in: WHERE[t.kind] ?? 'a note',
    ...(t.context ? { about: t.context } : {}),
    ...(earlier.length ? { earlier_the_same_day: earlier } : {}),
  };
}

export const AREAS = ['knee', 'shoulder', 'back', 'elbow_or_wrist', 'hip', 'ankle_or_foot', 'neck', 'other'] as const;
export const REASONS = ['travel', 'illness', 'work_or_study', 'family_or_event', 'other'] as const;
export const CHANGES = ['training_days', 'exercises', 'goal_or_weight', 'calories', 'other'] as const;

/**
 * The questions for one text. All judge `text` only; the earlier texts are
 * there to resolve "it" and "that". The yes/no questions say what does NOT
 * count, because the near misses are the common case: soreness after legs day,
 * a plan to train tomorrow, a question about how to do a lift.
 */
export const QUESTIONS: Record<string, JevQuestion> = {
  pain: {
    type: 'noul',
    instructions: 'Does `text` say the writer has pain or an injury NOW?',
    criteria: {
      true: 'The writer says a part of their body hurts, is injured, tweaked or strained, or gives them pain or discomfort in a joint or body part during or after a movement, now; or that pain is stopping or changing their training.',
      false: 'Normal muscle soreness or stiffness after training, tiredness, an old injury that has healed, someone else\'s pain, a general question about pain, or no pain at all.',
    },
  },
  area: {
    type: 'choice',
    instructions: 'If `text` mentions pain or an injury, where on the body is it?',
    criteria: {
      knee: 'The knee.',
      shoulder: 'The shoulder or rotator cuff.',
      back: 'The lower, middle or upper back, or the spine.',
      elbow_or_wrist: 'The elbow, forearm, wrist or hand.',
      hip: 'The hip, groin or glute.',
      ankle_or_foot: 'The ankle, foot, heel, shin or Achilles.',
      neck: 'The neck.',
      other: 'Anywhere else, more than one place, or not said.',
    },
  },
  life: {
    type: 'noul',
    instructions: 'Does `text` give a reason from the writer\'s life for missing, skipping or cutting short training or food logging?',
    criteria: {
      true: 'A life reason: travel or a trip, being ill or unwell, work or exams or study, family, a wedding, a festival, moving house, or another event that takes their time.',
      false: 'No reason given, pain or an injury (that is a different question), a reason about the plan itself (too hard, boring, too long), a plan for the future with nothing missed, or a question.',
    },
  },
  reason: {
    type: 'choice',
    instructions: 'If `text` gives a life reason for missing training or logging, which kind is it?',
    criteria: {
      travel: 'Travel, a trip, being away from home.',
      illness: 'Being ill, unwell, sick, a fever or a cold.',
      work_or_study: 'Work, a busy job, exams or study.',
      family_or_event: 'Family, a wedding, a festival, guests, moving house.',
      other: 'Another reason, or none given.',
    },
  },
  trained: {
    type: 'noul',
    instructions: 'Does `text` say the writer trained or worked out TODAY, the day they wrote it?',
    criteria: {
      true: 'They say they did a workout, a training session, a gym visit, a run or a sport today, or that they just finished one. A workout told in the past tense with no other day named counts as today.',
      false: 'A plan to train later, training on another day, a question about training, or nothing about training.',
    },
  },
  ask: {
    type: 'noul',
    instructions: 'Does `text` ask the coach to make a LASTING change to the writer\'s training plan or targets, or ask whether they should make one?',
    criteria: {
      true: 'Asks for fewer or more training days from now on, to swap or remove or add exercises in their plan, a different goal or target weight, different calories or macros, or another change that stays in their plan.',
      false: 'Advice for one session or one day only (what to do today or tomorrow, whether to skip something once), a question about how to do an exercise, about food they ate, about their progress, thanks, or general chat.',
    },
  },
  change: {
    type: 'choice',
    instructions: 'If `text` asks for a change to the plan, what kind of change?',
    criteria: {
      training_days: 'How many days or which days they train, or how long sessions are.',
      exercises: 'Swapping, removing or adding exercises.',
      goal_or_weight: 'Their goal, or their target weight.',
      calories: 'Calories, protein, carbs, fat or macros.',
      other: 'Anything else.',
    },
  },
};

/** The question names for one text, so one Jev call carries every text. */
export const questionKey = (textIndex: number, q: keyof typeof QUESTIONS) => `t${textIndex}_${q}`;

/** What Jev read in one text: noul scores 0..1 and choices, null when missing. */
export interface TextReading {
  id: string;
  day: string;
  pain: number | null;
  area: string | null;
  life: number | null;
  reason: string | null;
  trained: number | null;
  ask: number | null;
  change: string | null;
}

const asOne = <T extends readonly string[]>(v: unknown, allowed: T): T[number] | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T[number] : null;
const score = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Read one text's answers. `answers` is keyed by question name; a noul is
 * {type:'noul', noul}, a choice {type:'choice', choice}. Anything else is null.
 */
export function readText(t: WordText, i: number, answers: Record<string, unknown>): TextReading {
  const get = (q: keyof typeof QUESTIONS) => answers[questionKey(i, q)] as Record<string, unknown> | undefined;
  const noul = (q: keyof typeof QUESTIONS) => {
    const a = get(q);
    return a?.type === 'noul' ? score(a.noul) : null;
  };
  const choice = (q: keyof typeof QUESTIONS) => {
    const a = get(q);
    return a?.type === 'choice' ? a.choice : null;
  };
  return {
    id: t.id, day: t.day,
    pain: noul('pain'), area: asOne(choice('area'), AREAS),
    life: noul('life'), reason: asOne(choice('reason'), REASONS),
    trained: noul('trained'),
    ask: noul('ask'), change: asOne(choice('change'), CHANGES),
  };
}

/** Which plan_changes entities answer an ask of each kind. */
const CHANGE_ENTITIES: Record<string, string[] | null> = {
  training_days: ['routine', 'program', 'phase'],
  exercises: ['routine_exercises', 'routine'],
  goal_or_weight: ['goal', 'program', 'phase'],
  calories: ['targets', 'phase'],
  other: null, // any change at all
};

const yes = (v: number | null) => v != null && v >= YES;

/** The day before a YYYY-MM-DD, by its parts (no zone can move it). */
function dayBefore(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 86_400_000).toISOString().slice(0, 10);
}

/** The four signals for the week, fired or not, with what code worked out. */
export function wordSignals(f: WordFacts, readings: TextReading[]): StoredSignal[] {
  const sessionDays = new Set(f.session_days ?? []);
  const changes = f.plan_changes ?? [];
  const sessions = typeof f.sessions === 'number' ? f.sessions : null;
  const planned = typeof f.planned === 'number' ? f.planned : null;
  // The newest reading wins each signal: it is what is true now.
  const last = <T>(xs: T[]) => xs[xs.length - 1];

  const pain = last(readings.filter((r) => yes(r.pain)));
  const life = last(readings.filter((r) => yes(r.life)));
  // "Trained" also reads soreness the morning after ("quads destroyed after leg
  // day"), so a session logged the day before answers it too (held-out eval).
  const trainedUnlogged = last(readings.filter((r) =>
    yes(r.trained) && !sessionDays.has(r.day) && !sessionDays.has(dayBefore(r.day))));
  const unanswered = last(readings.filter((r) => {
    if (!yes(r.ask)) return false;
    const entities = CHANGE_ENTITIES[r.change ?? 'other'] ?? null;
    return !changes.some((c) => c.day >= r.day && (entities == null || entities.includes(c.entity)));
  }));
  const trainingShort = planned != null && planned > 0 && sessions != null && sessions < planned / 2;

  return [
    { signal: 'hurting', fired: !!pain,
      detail: pain ? { area: pain.area ?? 'other', day: pain.day, source: pain.id, score: pain.pain } : {} },
    { signal: 'life_got_in_the_way', fired: !!life && trainingShort,
      detail: life
        ? { reason: life.reason ?? 'other', day: life.day, source: life.id, score: life.life, sessions, planned }
        : { sessions, planned } },
    { signal: 'trains_not_logging', fired: !!trainedUnlogged,
      detail: trainedUnlogged ? { day: trainedUnlogged.day, source: trainedUnlogged.id, score: trainedUnlogged.trained } : {} },
    { signal: 'asked_for_a_change', fired: !!unanswered,
      detail: unanswered ? { change: unanswered.change ?? 'other', day: unanswered.day, source: unanswered.id, score: unanswered.ask } : {} },
  ];
}

/**
 * The stored signals as behaviour rows for the pick. Words beat numbers: these
 * sit above the number behaviours, and each quiets the cards it would argue
 * with ('topic:<x>' mutes; a pick card's topic is its behaviour name).
 */
export function wordBehaviours(signals: StoredSignal[] | null | undefined): BehaviourRow[] {
  const rows: BehaviourRow[] = [];
  for (const s of signals ?? []) {
    if (!s?.fired) continue;
    const detail = s.detail ?? {};
    if (s.signal === 'hurting') {
      rows.push({ behaviour: 'hurting', priority: 5, card_kind: 'talk', detail,
        mutes: ['topic:lift_stall', 'topic:plan_too_big', 'topic:exercise_skipped', 'topic:due_session'] });
    } else if (s.signal === 'asked_for_a_change') {
      const change = detail.change;
      rows.push({ behaviour: 'asked_for_a_change', priority: 15, card_kind: 'talk', detail,
        mutes: change === 'training_days' ? ['topic:plan_too_big']
          : change === 'goal_or_weight' ? ['topic:goals_unclear'] : [] });
    } else if (s.signal === 'life_got_in_the_way') {
      rows.push({ behaviour: 'life_got_in_the_way', priority: 18,
        card_kind: detail.reason === 'illness' ? 'notice' : 'talk', detail,
        mutes: ['topic:drifting_away', 'topic:plan_too_big', 'topic:due_session'] });
    } else if (s.signal === 'trains_not_logging') {
      rows.push({ behaviour: 'trains_not_logging', priority: 19, card_kind: 'notice', detail,
        mutes: ['topic:drifting_away', 'topic:due_session'] });
    }
  }
  return rows;
}
