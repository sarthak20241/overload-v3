// Run with: deno test --allow-all lib/calorieBars.test.ts
//
// The Analytics calorie bars. Users said the old line chart (scaled to the
// period's own highs and lows, no goal) did not help; these pin how each day is
// judged against its own goal and what the summary counts.

import { assertEquals } from 'jsr:@std/assert@1';
import { calorieBars, rangeFor, statusFor } from './calorieBars.ts';

Deno.test('the range is the goal plus or minus 10%', () => {
  assertEquals(rangeFor(1800), { lo: 1620, hi: 1980 });
  assertEquals(rangeFor(0), { lo: 0, hi: 0 });
  assertEquals(rangeFor(Number.NaN), { lo: 0, hi: 0 });
});

Deno.test('a day is under, in or over its range, edges included', () => {
  assertEquals(statusFor(1619, 1800), 'under');
  assertEquals(statusFor(1620, 1800), 'in');
  assertEquals(statusFor(1980, 1800), 'in');
  assertEquals(statusFor(1981, 1800), 'over');
  assertEquals(statusFor(0, 1800), 'none');
});

Deno.test('a logged day with no goal is not called under or over', () => {
  assertEquals(statusFor(1500, 0), 'in');
});

Deno.test('each day is judged against its own goal, so a fuel day has its own range', () => {
  const goal = (d: string) => (d === '2026-10-21' ? 2200 : 1800);
  const { bars } = calorieBars(
    [{ dayIso: '2026-10-20', kcal: 2100 }, { dayIso: '2026-10-21', kcal: 2100 }],
    goal,
    '2026-10-23',
  );
  assertEquals(bars.map((b) => [b.goal, b.status]), [[1800, 'over'], [2200, 'in']]);
});

Deno.test('today is drawn but not counted: half a day under its goal is not a miss', () => {
  const { bars, summary } = calorieBars(
    [{ dayIso: '2026-10-22', kcal: 1800 }, { dayIso: '2026-10-23', kcal: 600 }],
    () => 1800,
    '2026-10-23',
  );
  assertEquals(bars.map((b) => b.today), [false, true]);
  assertEquals(bars[1].status, 'under');
  assertEquals(summary, { logged: 1, inRange: 1, avgKcal: 1800 });
});

Deno.test('days with nothing logged are not counted and do not pull the average down', () => {
  const { summary } = calorieBars(
    [
      { dayIso: '2026-10-19', kcal: 0 },
      { dayIso: '2026-10-20', kcal: 1700 },
      { dayIso: '2026-10-21', kcal: 2300 },
      { dayIso: '2026-10-22', kcal: 1500 },
    ],
    () => 1800,
    '2026-10-23',
  );
  assertEquals(summary, { logged: 3, inRange: 1, avgKcal: 1833 });
});

Deno.test('only today logged: nothing to sum up yet', () => {
  const { summary } = calorieBars([{ dayIso: '2026-10-23', kcal: 900 }], () => 1800, '2026-10-23');
  assertEquals(summary, { logged: 0, inRange: 0, avgKcal: null });
});
