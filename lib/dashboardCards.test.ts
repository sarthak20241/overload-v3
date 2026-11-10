// deno test --allow-all --unstable-sloppy-imports --import-map=lib/test-import-map.json lib/dashboardCards.test.ts
//
// The dashboard's four card questions answered from one read: each answer must
// match what its own query used to return.
import { assertEquals } from 'jsr:@std/assert@1';
import { dashboardCardsFilter, splitDashboardCards, type CardRow } from './dashboardCards.ts';

const NOW = '2026-11-10T12:00:00.000Z'; // a Tuesday; the week starts 2026-11-09
const DAY = '2026-11-10';

const row = (r: Partial<CardRow> & { id: string }): CardRow & { id: string } => ({
  slot: 'weekly', week_start: '2026-11-09', status: 'pending', deferred_at: null, expires_at: null, created_at: null, ...r,
});

Deno.test('weekly and calories each take their own slot, the newest week near the phone', () => {
  const rows = [
    row({ id: 'w-old', week_start: '2026-11-02' }),
    row({ id: 'w-now', week_start: '2026-11-09' }),
    row({ id: 'c-now', slot: 'calories', week_start: '2026-11-09' }),
  ];
  const out = splitDashboardCards(rows, DAY, NOW);
  assertEquals(out.weekly?.id, 'w-now');
  assertEquals(out.checkin?.id, 'c-now');
});

Deno.test('a week with no check-in is null, not the weekly card', () => {
  const out = splitDashboardCards([row({ id: 'w' })], DAY, NOW);
  assertEquals(out.checkin, null);
  assertEquals(out.weekly?.id, 'w');
});

Deno.test('a card further than a week from the phone is not current', () => {
  const out = splitDashboardCards([row({ id: 'w', week_start: '2026-10-26' })], DAY, NOW);
  assertEquals(out.weekly, null);
});

Deno.test('the moment is the newest pending one, not put off, not expired', () => {
  const rows = [
    row({ id: 'm-old', slot: 'moment', created_at: '2026-11-09T08:00:00Z', expires_at: '2026-11-11T08:00:00Z' }),
    row({ id: 'm-new', slot: 'moment', created_at: '2026-11-10T08:00:00Z', expires_at: '2026-11-12T08:00:00Z' }),
    row({ id: 'm-later', slot: 'moment', created_at: '2026-11-10T09:00:00Z', expires_at: '2026-11-12T09:00:00Z', deferred_at: '2026-11-10T09:30:00Z' }),
    row({ id: 'm-gone', slot: 'moment', created_at: '2026-11-10T10:00:00Z', expires_at: '2026-11-10T11:00:00Z' }),
    row({ id: 'm-done', slot: 'moment', status: 'applied', created_at: '2026-11-10T11:00:00Z', expires_at: '2026-11-12T11:00:00Z' }),
  ];
  assertEquals(splitDashboardCards(rows, DAY, NOW).moment?.id, 'm-new');
});

Deno.test('a moment never answers the weekly question', () => {
  const rows = [row({ id: 'm', slot: 'moment', created_at: NOW, expires_at: '2026-11-12T00:00:00Z' })];
  assertEquals(splitDashboardCards(rows, DAY, NOW).weekly, null);
});

Deno.test('the bell counts pending cards put off with Later and not expired, any slot', () => {
  const rows = [
    row({ id: 'a', deferred_at: NOW, expires_at: '2026-11-15T23:59:59Z' }),
    row({ id: 'b', slot: 'calories', deferred_at: NOW, expires_at: '2026-11-15T23:59:59Z' }),
    row({ id: 'c', deferred_at: NOW, expires_at: '2026-11-09T00:00:00Z' }), // expired
    row({ id: 'd', status: 'dismissed', deferred_at: NOW, expires_at: '2026-11-15T23:59:59Z' }),
    row({ id: 'e', expires_at: '2026-11-15T23:59:59Z' }), // not put off
  ];
  assertEquals(splitDashboardCards(rows, DAY, NOW).waiting, 2);
});

Deno.test('the read reaches back one week before the phone week, far enough for every pick', () => {
  assertEquals(dashboardCardsFilter(DAY, NOW), { sinceWeek: '2026-11-02', nowIso: NOW });
});
