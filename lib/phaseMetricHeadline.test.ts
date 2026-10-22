// deno test --allow-all --unstable-sloppy-imports lib/phaseMetricHeadline.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { metricHeadline, liveFrom, headlineText, type LiveReadings } from './phaseMetricHeadline.ts';

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
