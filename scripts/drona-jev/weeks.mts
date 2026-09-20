/**
 * The Jev eval set: fortnights with a known right answer.
 *
 * Each week is built from a SPEC (how fast weight moves, how noisy the scale is,
 * how many days are logged...). The truth for every signal is DERIVED from the
 * spec by the same definitions the question criteria state, so a label can
 * never drift from its data. The expected CARD is hand-labelled: that is the
 * curation, and the priority order it follows is the one in WHICH_CARD.
 *
 * Data is seeded-random on purpose. The first six packs were robotic (the same
 * four kcal values in a loop), and a model that reads robotic data well proves
 * little about a real person's log.
 *
 * Groups: clean cases per card, NEAR-MISSES (just on the safe side of a line),
 * and MIXED weeks where two things are true and priority decides.
 */
import type { JevCard, SignalName } from '../../supabase/functions/_shared/dronaJev.ts';

export const AS_OF = '2026-09-20'; // a Sunday, so the most recent training week is complete
const dayBack = (back: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

type Goal = 'fat_loss' | 'muscle_gain' | 'maintain';
interface Change { days_ago: number; from: number; to: number; changed_by: 'coach_chat' | 'coach_card' | 'user_by_hand' }
export interface Spec {
  name: string;
  group: 'clean' | 'near-miss' | 'mixed' | 'fresh';
  why: string;
  expect: JevCard;
  goal: Goal; kg: number; goalKg: number; kcal: number; protein: number;
  pctPerWeek: number;        // body weight change per week, % (negative = losing)
  wobbleKg: number;          // day-to-day noise amplitude
  weighIns: number;          // count in 14 days
  daysLogged: number;        // count in 14 days
  kcalOffset: number;        // mean offset from target on normal days
  highDays?: { count: number; kcal: number };
  proteinShare: number;      // mean protein / target
  changes: Change[];
  planned: number; done: [number, number, number, number]; // oldest .. most recent week
  daysSinceLast: number;
  notes?: string[];
  /** Overrides the keyword guess: a note about a trip that already ended explains nothing. */
  explained?: boolean;
}

const D: Omit<Spec, 'name' | 'group' | 'why' | 'expect'> = {
  goal: 'fat_loss', kg: 78, goalKg: 72, kcal: 2000, protein: 150,
  pctPerWeek: 0, wobbleKg: 0.15, weighIns: 10, daysLogged: 12, kcalOffset: -10,
  proteinShare: 0.98,
  changes: [{ days_ago: 25, from: 2150, to: 2000, changed_by: 'coach_chat' }],
  planned: 4, done: [4, 4, 4, 4], daysSinceLast: 1,
};
const w = (name: string, group: Spec['group'], expect: JevCard, why: string, over: Partial<Spec> = {}): Spec =>
  ({ ...D, ...over, name, group, expect, why });

export const SPECS: Spec[] = [
  // ── lower calories: an honest stall on a cut ───────────────────────────────
  w('stall-plain', 'clean', 'propose_lower_calories', 'near target, flat, earlier cut on record'),
  w('stall-no-history', 'clean', 'propose_lower_calories', 'same, no change history at all', { changes: [] }),
  w('stall-heavier-person', 'clean', 'propose_lower_calories', 'different body and targets', { kg: 104, goalKg: 90, kcal: 2600, protein: 190 }),
  w('stall-lighter-person', 'clean', 'propose_lower_calories', 'small person, small numbers', { kg: 58, goalKg: 54, kcal: 1550, protein: 110 }),
  w('stall-7-weigh-ins', 'clean', 'propose_lower_calories', 'fewer weigh-ins but enough', { weighIns: 7, daysLogged: 10 }),
  // ── raise calories ─────────────────────────────────────────────────────────
  w('cut-too-fast', 'clean', 'propose_raise_calories', 'losing 1.3% a week', { pctPerWeek: -1.3 }),
  w('cut-too-fast-heavy', 'clean', 'propose_raise_calories', 'losing 1.1% a week at 104 kg', { kg: 104, goalKg: 90, kcal: 2400, protein: 190, pctPerWeek: -1.1 }),
  w('bulk-stalled', 'clean', 'propose_raise_calories', 'muscle gain goal, scale flat', { goal: 'muscle_gain', kg: 70, goalKg: 76, kcal: 2900, protein: 160, changes: [] }),
  // ── lower calories on a bulk ───────────────────────────────────────────────
  w('bulk-too-fast', 'clean', 'propose_lower_calories', 'muscle gain, up 0.8% a week', { goal: 'muscle_gain', kg: 70, goalKg: 76, kcal: 3100, protein: 160, pctPerWeek: 0.8, changes: [] }),
  // ── hold: on track ─────────────────────────────────────────────────────────
  w('cut-on-track', 'clean', 'hold', 'losing 0.6% a week, all good', { pctPerWeek: -0.6 }),
  w('bulk-on-track', 'clean', 'hold', 'gaining 0.25% a week', { goal: 'muscle_gain', kg: 70, goalKg: 76, kcal: 2900, protein: 160, pctPerWeek: 0.25, changes: [] }),
  w('changed-5-days-ago', 'clean', 'hold', 'flat, but the target moved 5 days ago: too soon', { changes: [{ days_ago: 5, from: 2150, to: 2000, changed_by: 'coach_card' }] }),
  w('maintain-flat', 'clean', 'hold', 'maintenance goal and flat is the goal', { goal: 'maintain', goalKg: 78, changes: [] }),
  // ── high days ──────────────────────────────────────────────────────────────
  w('two-blowouts', 'clean', 'talk_about_high_days', 'two days at 170% of target', { highDays: { count: 2, kcal: 3400 } }),
  w('three-weekend-days', 'clean', 'talk_about_high_days', 'three days at 150%', { highDays: { count: 3, kcal: 3000 } }),
  w('one-huge-day', 'clean', 'talk_about_high_days', 'one day at 190%', { highDays: { count: 1, kcal: 3800 } }),
  w('one-mild-day', 'near-miss', 'propose_lower_calories', 'one day at 125%: over, but not FAR over', { highDays: { count: 1, kcal: 2500 } }),
  // ── eating well over target, every day ─────────────────────────────────────
  w('over-every-day', 'clean', 'talk_about_eating_over_target', 'averages 22% over target; the number is not the problem', { kcalOffset: 440 }),
  w('over-every-day-heavy', 'clean', 'talk_about_eating_over_target', '18% over at 2600', { kg: 104, goalKg: 90, kcal: 2600, protein: 190, kcalOffset: 470 }),
  w('slightly-over', 'near-miss', 'propose_lower_calories', '6% over is still near target', { kcalOffset: 120 }),
  // ── the person undid a coach change ────────────────────────────────────────
  w('undid-card-cut', 'clean', 'talk_about_undone_change', 'card cut, user raised it back', { changes: [
    { days_ago: 30, from: 2000, to: 1850, changed_by: 'coach_card' }, { days_ago: 20, from: 1850, to: 2000, changed_by: 'user_by_hand' }] }),
  w('undid-chat-cut-long-ago', 'clean', 'talk_about_undone_change', 'chat cut undone 45 days ago', { changes: [
    { days_ago: 52, from: 2000, to: 1900, changed_by: 'coach_chat' }, { days_ago: 45, from: 1900, to: 2000, changed_by: 'user_by_hand' }] }),
  w('user-set-own-number', 'near-miss', 'propose_lower_calories', 'a hand edit with NO coach change before it is not an undo', { changes: [
    { days_ago: 40, from: 2200, to: 2000, changed_by: 'user_by_hand' }] }),
  // ── the scale ──────────────────────────────────────────────────────────────
  w('jumpy-scale', 'clean', 'request_steadier_weigh_ins', 'swings about 1.8 kg day to day', { wobbleKg: 0.9 }),
  w('very-jumpy-scale', 'clean', 'request_steadier_weigh_ins', 'swings about 2.4 kg', { wobbleKg: 1.2 }),
  w('normal-wobble', 'near-miss', 'propose_lower_calories', '0.35 kg wobble is a normal scale', { wobbleKg: 0.35 }),
  w('two-weigh-ins', 'clean', 'request_weigh_ins', 'two weigh-ins in 14 days', { weighIns: 2 }),
  w('no-weigh-ins', 'clean', 'request_weigh_ins', 'none at all', { weighIns: 0 }),
  w('five-weigh-ins', 'near-miss', 'propose_lower_calories', 'five is thin but readable', { weighIns: 5 }),
  // ── food logging ───────────────────────────────────────────────────────────
  w('four-days-logged', 'clean', 'request_more_food_logging', '4 of 14', { daysLogged: 4 }),
  w('nothing-logged', 'clean', 'request_more_food_logging', '0 of 14', { daysLogged: 0 }),
  w('eight-days-logged', 'near-miss', 'propose_lower_calories', '8 of 14 is enough', { daysLogged: 8 }),
  // ── protein ────────────────────────────────────────────────────────────────
  w('protein-half', 'clean', 'propose_protein_fix', '47% of protein target', { proteinShare: 0.47 }),
  w('protein-two-thirds', 'clean', 'propose_protein_fix', '65% of target', { proteinShare: 0.65 }),
  w('protein-nearly', 'near-miss', 'propose_lower_calories', '88% of target is fine', { proteinShare: 0.88 }),
  // ── training drift ─────────────────────────────────────────────────────────
  w('two-of-four-for-weeks', 'clean', 'talk_about_missed_training', '2 of 4 three weeks running', { pctPerWeek: -0.5, done: [4, 2, 2, 2], daysSinceLast: 3 }),
  w('one-of-four-two-weeks', 'clean', 'talk_about_missed_training', '1 of 4, twice', { pctPerWeek: -0.5, done: [4, 4, 1, 1], daysSinceLast: 5 }),
  w('stopped-entirely', 'clean', 'talk_about_missed_training', 'nothing for two weeks', { pctPerWeek: -0.5, done: [4, 3, 0, 0], daysSinceLast: 16 }),
  w('one-short-week', 'clean', 'offer_to_relay_week', '4,4,4 then 1', { pctPerWeek: -0.5, done: [4, 4, 4, 1], daysSinceLast: 4 }),
  w('one-short-week-5-plan', 'clean', 'offer_to_relay_week', '5,5,5 then 2', { pctPerWeek: -0.5, planned: 5, done: [5, 5, 5, 2], daysSinceLast: 3 }),
  w('three-of-four', 'near-miss', 'hold', '3 of 4 is a normal week; on track', { pctPerWeek: -0.5, done: [4, 4, 4, 3] }),
  // ── a note explains it ─────────────────────────────────────────────────────
  w('travel-note', 'clean', 'hold', 'missed training, but they said they are travelling', { pctPerWeek: -0.5, done: [4, 4, 1, 0], daysSinceLast: 12,
    notes: ['2026-09-08: Said they are travelling for work until 30 September and will have no gym.'] }),
  w('injury-note', 'clean', 'hold', 'stopped, knee injury, physio said two weeks', { pctPerWeek: -0.3, done: [4, 2, 0, 0], daysSinceLast: 15,
    notes: ['2026-09-06: Hurt their knee. Physio said rest for about two weeks, back around 22 September.'] }),
  w('old-note-does-not-explain', 'near-miss', 'talk_about_missed_training', 'the note is about food, not the missing sessions', { pctPerWeek: -0.5, done: [4, 2, 2, 1], daysSinceLast: 6,
    notes: ['2026-07-02: Prefers chicken and rice on training days.'] }),
  // ── mixed: two things are true, priority decides ───────────────────────────
  w('blowouts-and-low-protein', 'mixed', 'talk_about_high_days', 'high days outrank protein', { highDays: { count: 2, kcal: 3300 }, proteinShare: 0.6 }),
  w('undone-cut-and-blowouts', 'mixed', 'talk_about_undone_change', 'the undone change outranks everything', { highDays: { count: 2, kcal: 3300 }, changes: [
    { days_ago: 30, from: 2000, to: 1850, changed_by: 'coach_card' }, { days_ago: 22, from: 1850, to: 2000, changed_by: 'user_by_hand' }] }),
  w('jumpy-and-flat', 'mixed', 'request_steadier_weigh_ins', 'cannot call a stall on a scale this noisy', { wobbleKg: 1.0 }),
  w('drift-and-stall', 'mixed', 'talk_about_missed_training', 'missed training for weeks AND a food stall: training first', { done: [4, 2, 1, 1], daysSinceLast: 6 }),
  w('sparse-food-and-flat', 'mixed', 'request_more_food_logging', 'flat scale, but only 3 food days: cannot judge intake', { daysLogged: 3 }),
  w('few-weigh-ins-and-low-protein', 'mixed', 'request_weigh_ins', 'weigh-ins come before protein', { weighIns: 1, proteinShare: 0.55 }),

  // ── FRESH: written AFTER the wording and the data builder were tuned on the
  // weeks above, and never used to tune anything. This is the honest score.
  // Different people, different numbers, boundaries, and cases the rules only
  // cover in spirit (a reversed RAISE, a note about a trip that already ended).
  w('fresh-stall-62kg', 'fresh', 'propose_lower_calories', 'small person, honest stall', { kg: 62, goalKg: 57, kcal: 1650, protein: 120, changes: [] }),
  w('fresh-cut-fast-88kg', 'fresh', 'propose_raise_calories', 'losing 1.2% a week', { kg: 88, goalKg: 80, kcal: 2200, protein: 170, pctPerWeek: -1.2 }),
  w('fresh-bulk-fast-82kg', 'fresh', 'propose_lower_calories', 'bulk, up 0.7% a week', { goal: 'muscle_gain', kg: 82, goalKg: 88, kcal: 3300, protein: 180, pctPerWeek: 0.7, changes: [] }),
  w('fresh-bulk-ok', 'fresh', 'hold', 'bulk, up 0.35% a week', { goal: 'muscle_gain', kg: 82, goalKg: 88, kcal: 3200, protein: 180, pctPerWeek: 0.35, changes: [] }),
  w('fresh-birthday', 'fresh', 'talk_about_high_days', 'one day at 160% on a 1650 target', { kg: 62, goalKg: 57, kcal: 1650, protein: 120, highDays: { count: 1, kcal: 2640 } }),
  w('fresh-undid-a-raise', 'fresh', 'talk_about_undone_change', 'the coach RAISED the target and the user put it back: still a reversal', { pctPerWeek: -0.6, kcal: 2200, changes: [
    { days_ago: 28, from: 2200, to: 2350, changed_by: 'coach_card' }, { days_ago: 21, from: 2350, to: 2200, changed_by: 'user_by_hand' }] }),
  w('fresh-jumpy-64kg', 'fresh', 'request_steadier_weigh_ins', 'a light person, 1 kg wobble', { kg: 64, goalKg: 60, kcal: 1700, protein: 125, wobbleKg: 1.0 }),
  w('fresh-exactly-three-weigh-ins', 'fresh', 'request_weigh_ins', 'the boundary: three', { weighIns: 3 }),
  w('fresh-six-days-logged', 'fresh', 'request_more_food_logging', 'the boundary: six', { daysLogged: 6 }),
  w('fresh-seven-days-logged', 'fresh', 'propose_lower_calories', 'seven is enough', { daysLogged: 7 }),
  w('fresh-protein-78pct', 'fresh', 'propose_protein_fix', 'just under the line', { proteinShare: 0.78 }),
  w('fresh-3-day-plan-missed', 'fresh', 'talk_about_missed_training', 'planned 3, did 1 and 1', { pctPerWeek: -0.5, planned: 3, done: [3, 3, 1, 1], daysSinceLast: 5 }),
  w('fresh-6-day-plan-one-short', 'fresh', 'offer_to_relay_week', 'planned 6: 6, 5, 6, then 2', { pctPerWeek: -0.5, planned: 6, done: [6, 5, 6, 2], daysSinceLast: 2 }),
  w('fresh-flu-note', 'fresh', 'hold', 'flu, doctor says rest', { pctPerWeek: -0.4, done: [4, 4, 1, 0], daysSinceLast: 11,
    notes: ['2026-09-13: Down with flu since the 12th. Doctor says rest this week, maybe next.'] }),
  w('fresh-trip-already-over', 'fresh', 'talk_about_missed_training', 'the trip ended two weeks ago; the note no longer explains anything', { pctPerWeek: -0.5, done: [4, 1, 1, 1], daysSinceLast: 6, explained: false,
    notes: ['2026-08-20: Travelling until 5 September, no gym access.'] }),
  w('fresh-over-target-and-short-week', 'fresh', 'offer_to_relay_week', 'eating 20% over AND one short week: the week comes first', { kcalOffset: 400, done: [4, 4, 4, 1], daysSinceLast: 5 }),
  w('fresh-low-protein-and-fast-cut', 'fresh', 'propose_protein_fix', 'protein 60% AND losing 1.2% a week: protein first', { pctPerWeek: -1.2, proteinShare: 0.6 }),
  w('fresh-changed-8-days-ago', 'fresh', 'hold', 'flat, but the target moved 8 days ago', { changes: [{ days_ago: 8, from: 2100, to: 2000, changed_by: 'coach_chat' }] }),
];

/**
 * A label is only honest if the data shows it. Random noise can betray a spec:
 * one seed turned a "jumpy" scale into 0.5 kg swings with a fake downward trend,
 * and Jev was right to call that week healthy progress. So each week reseeds
 * until its realised numbers say what its spec says.
 */
function realises(s: Spec, st: any): boolean {
  const w = st.weigh_in_summary;
  if (w.count < 4) return true;
  const swing = w.typical_change_between_neighbouring_weigh_ins_kg;
  if (s.wobbleKg >= 0.7) return swing >= 0.9;
  return swing <= 0.5 && Math.abs(w.trend_pct_of_body_weight_per_week - s.pctPerWeek) <= 0.1;
}
export function stateFor(s: Spec) {
  for (let i = 0; i < 200; i++) {
    const st = build(s, `${s.name}#${i}`);
    if (realises(s, st)) return st;
  }
  throw new Error(`no seed realises ${s.name}`);
}

// ── building the state Jev sees ──────────────────────────────────────────────
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10_000) / 10_000; };
}
const r1 = (v: number) => Math.round(v * 10) / 10;

function build(s: Spec, seed: string) {
  const rand = rng(seed);
  // Weigh-ins, spread over the fortnight, newest first.
  const slots = s.weighIns <= 0 ? [] : Array.from({ length: s.weighIns }, (_, i) => Math.round((i * 13) / Math.max(1, s.weighIns - 1)));
  const weighIns = [...new Set(slots)].map((back) => {
    const trend = s.kg * (1 - (s.pctPerWeek / 100) * (back / 7));
    const noise = (rand() < 0.5 ? 1 : -1) * s.wobbleKg * (0.75 + 0.25 * rand());
    return { day: dayBack(back), kg: r1(trend + noise) };
  });
  // Arithmetic belongs in code, judgment in Jev. The first version averaged the
  // three oldest and three newest readings, and on a noisy scale that leaves a
  // residue: a perfectly flat person read as "falling 0.35% a week", and Jev
  // answered correctly from a false number. A least-squares slope over every
  // reading has no such residue (production uses regr_slope for the same reason).
  const pts = weighIns.map((p) => ({ x: -(Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${p.day}T00:00:00Z`)) / 86_400_000, y: p.kg }));
  const n = pts.length, mx = pts.reduce((a, p) => a + p.x, 0) / (n || 1), my = pts.reduce((a, p) => a + p.y, 0) / (n || 1);
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const slopePerDay = sxx > 0 ? pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx : 0;
  const swings = weighIns.slice(1).map((p, i) => Math.abs(p.kg - weighIns[i].kg));
  const weigh_in_summary = n >= 4 ? {
    count: n,
    average_kg: r1(my),
    trend_kg_per_week: Math.round(slopePerDay * 7 * 100) / 100,
    trend_pct_of_body_weight_per_week: Math.round((slopePerDay * 7 / my) * 100 * 100) / 100,
    typical_change_between_neighbouring_weigh_ins_kg: Math.round((swings.reduce((a, b) => a + b, 0) / swings.length) * 100) / 100,
  } : { count: n };

  // Food: which days are logged, then the high days dropped onto weekend-ish slots.
  const logged = Array.from({ length: 14 }, (_, i) => i).sort(() => rand() - 0.5).slice(0, s.daysLogged).sort((a, b) => a - b);
  const highIdx = new Set((s.highDays ? logged.filter((d) => [1, 6, 7, 8, 13].includes(d)) : []).slice(0, s.highDays?.count ?? 0));
  const food = logged.map((back) => ({
    day: dayBack(back),
    kcal: highIdx.has(back) ? s.highDays!.kcal + Math.round((rand() - 0.5) * 120) : Math.round(s.kcal + s.kcalOffset + (rand() - 0.5) * 2 * 70),
    protein_g: Math.round(s.protein * s.proteinShare * (0.93 + 0.14 * rand())),
  }));
  const avgKcal = food.length ? food.reduce((a, b) => a + b.kcal, 0) / food.length : 0;
  const avgProt = food.length ? food.reduce((a, b) => a + b.protein_g, 0) / food.length : 0;
  const near = food.filter((f) => Math.abs(f.kcal - s.kcal) <= s.kcal * 0.1).length;
  // Jev is not a calculator: every percentage it needs is worked out here.
  const food_summary = { days_logged: food.length, of_days: 14,
    ...(food.length ? {
      avg_kcal: Math.round(avgKcal), avg_kcal_pct_of_target: Math.round((avgKcal / s.kcal) * 100),
      days_within_10pct_of_target: near,
      highest_day_kcal: Math.max(...food.map((f) => f.kcal)), highest_day_pct_of_target: Math.round((Math.max(...food.map((f) => f.kcal)) / s.kcal) * 100),
      avg_protein_g: Math.round(avgProt), avg_protein_pct_of_target: Math.round((avgProt / s.protein) * 100),
    } : {}) };

  const mondays = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14'];
  return {
    today: AS_OF,
    goal: { kind: s.goal, current_kg: s.kg, goal_kg: s.goalKg },
    daily_targets: { kcal: s.kcal, protein_g: s.protein },
    food_summary, food_log_last_14_days: food,
    weigh_in_summary, weigh_ins_last_14_days: weighIns,
    calorie_target_changes: s.changes.map((c) => ({ date: dayBack(c.days_ago), days_ago: c.days_ago, from_kcal: c.from, to_kcal: c.to, changed_by: c.changed_by })),
    training_by_week: mondays.map((m, i) => ({ week_of: m, planned_sessions: s.planned, done_sessions: s.done[i], done_pct_of_planned: Math.round((s.done[i] / s.planned) * 100) })),
    days_since_last_session: s.daysSinceLast,
    coach_notes: s.notes ?? [],
  };
}

/** The truth for each signal, from the spec. null = not a fair question for this week. */
export function truthFor(s: Spec): Record<SignalName, boolean | null> {
  const readable = s.weighIns >= 4 && s.wobbleKg < 0.7;
  const undid = s.changes.some((c, i) => c.changed_by === 'user_by_hand' && s.changes.some((e, j) => j !== i && e.changed_by !== 'user_by_hand' && e.days_ago > c.days_ago && e.to === c.from));
  const recent = s.done[3] / s.planned, before = s.done[2] / s.planned;
  return {
    weight_is_flat: readable ? Math.abs(s.pctPerWeek) < 0.15 : null,
    weight_falling_fast: readable ? s.pctPerWeek <= -1.0 : null,
    weight_rising_fast: readable ? s.pctPerWeek >= 0.5 : null,
    scale_is_jumpy: s.weighIns >= 4 ? s.wobbleKg >= 0.7 : null,
    few_weigh_ins: s.weighIns <= 3,
    food_log_sparse: s.daysLogged <= 6,
    intake_near_target: s.daysLogged >= 7 ? Math.abs(s.kcalOffset) <= s.kcal * 0.1 : null,
    has_far_over_days: s.daysLogged >= 1 ? !!s.highDays && s.highDays.kcal >= s.kcal * 1.4 : false,
    protein_adequate: s.daysLogged >= 1 ? s.proteinShare >= 0.85 : null,
    user_undid_a_cut: undid,
    training_short_this_week: recent <= 0.5,
    training_short_for_weeks: recent <= 0.6 && before <= 0.6,
    absence_is_explained: s.explained ?? !!s.notes?.some((n) => /travel|knee|injur|physio|sick|ill|flu/i.test(n)),
  };
}
