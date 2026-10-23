// deno test --allow-all --unstable-sloppy-imports lib/phaseMetricHeadline.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { focusFromCoachLine, goalFocus, metricHeadline, liveFrom, headlineText, planRowLine, rowLine, type LiveReadings } from './phaseMetricHeadline.ts';

const base = { id: 'm', program_id: 'p', phase_id: 'ph', user_id: 'u', seq: 0, is_hero: false, ref: {}, unit: null, direction: 'up' as const, start_value: null, status_note: null, updated_at: '' };
const m = (kind: string, target: number, current: number | null, status = 'on_track') =>
  ({ ...base, kind, target_value: target, current_value: current, status } as any);
const live: LiveReadings = { sessionsThisWeek: 1, sleepAvg: 8, sleepNights: 2 };

Deno.test('a job reading reads as last week, with its status', () => {
  assertEquals(metricHeadline(m('sessions_per_week', 4, 3), live), { num: '3', rest: 'of 4 sessions last week', status: 'on_track' });
  assertEquals(metricHeadline(m('sleep_hours', 7, 7.3), live), { num: '7.3', rest: 'h a night last week', status: 'on_track' });
  assertEquals(metricHeadline(m('steps', 10000, 8200), live).rest, 'steps a day last week');
  assertEquals(metricHeadline(m('protein_days', 5, 5), live), { num: '5', rest: 'of 7 protein days last week', status: 'on_track', restShort: 'of 7 last week' });
  assertEquals(metricHeadline(m('cardio_sessions', 3, 2), live).rest, 'of 3 cardio last week');
});

Deno.test('the same line from a job reading on every screen', () => {
  assertEquals(headlineText(metricHeadline(m('sessions_per_week', 4, 3), live)), '3 of 4 sessions last week');
  assertEquals(headlineText(metricHeadline(m('sleep_hours', 7, 7.3), live)), '7.3 h a night last week');
});

Deno.test('no job reading yet: the live number, so far this week, no status word', () => {
  assertEquals(metricHeadline(m('sessions_per_week', 4, null, 'due'), live), { num: '1', rest: 'of 4 sessions so far this week', status: null });
  assertEquals(metricHeadline(m('sleep_hours', 7, null, 'due'), live), { num: '8', rest: 'h a night from 2 nights', status: null });
  assertEquals(metricHeadline(m('sleep_hours', 7, null, 'due'), { ...live, sleepNights: 5, sleepAvg: 7.25 }), { num: '7.3', rest: 'h a night, last 7 nights', status: null });
});

Deno.test('no job reading and no live source: say what feeds it; Due only when a sync is owed', () => {
  assertEquals(metricHeadline(m('steps', 10000, null, 'due'), live), { num: '', rest: 'Needs Health sync', status: null });
  assertEquals(metricHeadline(m('sleep_hours', 7, null, 'due'), { ...live, sleepAvg: null, sleepNights: 0 }), { num: '', rest: 'Needs Health sync', status: null });
  assertEquals(metricHeadline(m('sleep_hours', 7, null, 'set'), null), { num: '', rest: 'No reading yet', status: null });
  assertEquals(metricHeadline(m('protein_days', 5, null, 'due'), live), { num: '', rest: 'No reading yet', status: 'due' });
  assertEquals(metricHeadline(m('custom', 10, null, 'set'), live), { num: '', rest: 'Not logged yet', status: null });
  assertEquals(metricHeadline(m('lift_e1rm', 100, null, 'set'), live), { num: '', rest: 'Log the lift to start', status: null });
});

Deno.test('liveFrom: sessions this week and the sleep average over the nights that exist', () => {
  const week = { doneByDay: ['Push', null, 'Pull', null, null, null, null], count: 2 };
  const nights = [{ day: 'a', hours: 7.5 }, { day: 'b', hours: null }, { day: 'c', hours: 8.5 }];
  assertEquals(liveFrom(week, nights), { sessionsThisWeek: 2, sleepAvg: 8, sleepNights: 2 });
  assertEquals(liveFrom(null, []), { sessionsThisWeek: 0, sleepAvg: null, sleepNights: 0 });
});

Deno.test('the focus sentence never splits a decimal number', () => {
  // A status-only first sentence gives way to the action, whole.
  assertEquals(focusFromCoachLine('Behind the line this week. Hold 71.8 kg by Sunday.'), 'Hold 71.8 kg by Sunday.');
  assertEquals(focusFromCoachLine('Sleep averaged 6.5 h; get to 7.5 h this week. Lights out by 11.'), 'Sleep averaged 6.5 h; get to 7.5 h this week.');
  assertEquals(focusFromCoachLine('On pace! Keep the 2.5 kg plates on.'), 'Keep the 2.5 kg plates on.');
  assertEquals(focusFromCoachLine('Add one set to rows.'), 'Add one set to rows.');
});

Deno.test('a plan row always names what it measures, even in its short form', () => {
  // Protein days: the subject leads; the short form keeps it.
  assertEquals(rowLine(m('protein_days', 5, 5, 'slipping'), live), { text: 'Protein 5 of 7 days last week', short: '5 of 7 protein days last week', status: 'slipping' });
  // Sets name the muscle.
  assertEquals(rowLine({ ...m('sets_per_muscle', 12, 10), ref: { muscle: 'Chest' } }, live).text, 'Chest 10 of 12 sets last week');
  // Steps and cardio carry their subject in the words already.
  assertEquals(rowLine(m('steps', 10000, 8200), live).text, '8,200 steps a day last week');
  assertEquals(rowLine(m('steps', 10000, 8200), live).short, '8,200 steps/day last week');
  assertEquals(rowLine(m('cardio_sessions', 3, 2), live).text, '2 of 3 cardio last week');
  assertEquals(rowLine(m('sleep_hours', 7, 7.3), live).text, '7.3 h a night last week');
  assertEquals(rowLine(m('sessions_per_week', 4, 3), live).text, '3 of 4 sessions last week');
  // No reading: the subject is still there.
  assertEquals(rowLine(m('protein_days', 5, null, 'due'), live).text, 'Protein days: no reading yet');
  // No short form ever drops the subject.
  for (const kind of ['protein_days', 'steps', 'cardio_sessions', 'sleep_hours', 'sessions_per_week']) {
    const r = rowLine(m(kind, 5, 3), live);
    assertEquals(/protein|steps|cardio|night|sessions/i.test(r.short), true, `${kind}: ${r.short}`);
  }
});

Deno.test('a long focus sentence keeps its first clause, so it fits two lines whole', () => {
  assertEquals(
    focusFromCoachLine('A little behind this week. Keep protein at 115g and add the second cardio session; the scale usually follows a week later.'),
    'Keep protein at 115g and add the second cardio session.',
  );
  // A short sentence with a semicolon stays whole.
  assertEquals(focusFromCoachLine('Rest today; train tomorrow.'), 'Rest today; train tomorrow.');
});

Deno.test('the Goal screen focus: one short line, never cut', () => {
  const metrics = [
    { ...m('protein_days', 5, 4, 'slipping') }, { ...m('cardio_sessions', 2, 1, 'behind') },
    { ...m('steps', 8000, 7400, 'close') }, { ...m('bodyweight', 59, 65.9, 'behind'), is_hero: true },
  ];
  // A short coach action wins.
  assertEquals(goalFocus('A little behind this week. Add one cardio session.', metrics), 'Add one cardio session.');
  // A long one gives way to the built sentence: the two worst supporting targets.
  assertEquals(
    goalFocus('A little behind. Keep protein at 115g and add the second cardio session; the scale follows.', metrics),
    'Add a cardio session and hit your protein target.',
  );
  // Two asks that would run past 52 characters: only the worst one.
  const long = [{ ...m('sets_per_muscle', 16, 9, 'behind'), ref: { muscle: 'Upper chest' } }, { ...m('steps', 10000, 6000, 'slipping') }];
  const one = goalFocus(null, long);
  assertEquals(one.length <= 52, true, one);
  assertEquals(one.includes(' and '), false, one);
  // Nothing behind: no focus line at all.
  assertEquals(goalFocus(null, [{ ...m('protein_days', 5, 5, 'on_track') }]), '');
});

Deno.test('plan rows on the Goal screen: plan first, one short line, no "last week"', () => {
  assertEquals(planRowLine('train', { split: 'Push/Pull/Legs', days: 5 }), { text: 'Push / Pull / Legs · 5 days', status: null });
  assertEquals(planRowLine('eat', { kcal: 1800, proteinG: 115 }), { text: '1,800 kcal · 115 g protein', status: null });
  assertEquals(planRowLine('recover', { sleep: m('sleep_hours', 7, 7.3, 'on_track') }, live), { text: '7.3 h sleep', status: 'on_track' });
  // No job reading yet: the live average, no status word.
  assertEquals(planRowLine('recover', { sleep: m('sleep_hours', 7, null, 'due') }, { ...live, sleepAvg: 7.4, sleepNights: 5 }), { text: '7.4 h sleep', status: null });
  assertEquals(planRowLine('recover', {}, live, 72), { text: 'Readiness 72 today', status: null });
  assertEquals(planRowLine('train', {}), { text: 'Training plan', status: null });
  assertEquals(planRowLine('eat', {}), { text: 'Daily targets', status: null });
});
