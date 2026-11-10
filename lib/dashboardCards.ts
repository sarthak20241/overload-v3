/**
 * The dashboard's Drona cards from ONE read of drona_cards: this week's weekly
 * card, this week's calorie check-in, the newest waiting moment, and how many
 * cards were put off with Later (the bell). The dashboard used to ask four
 * times on every focus, one query per question, for rows of the same table.
 *
 * Pure, so `deno test lib/dashboardCards.test.ts` covers it. The rules are the
 * four old queries', row for row:
 *   weekly / calories  pickCurrentCard over that slot's rows (the server's week,
 *                      within 7 days either side of the phone's)
 *   moment             pending, not put off, not expired, newest created_at
 *   waiting            pending, put off with Later, not expired (any slot)
 */
import { pickCurrentCard, weekStartOf } from '@/lib/dronaRules';

export interface CardRow {
  slot?: string | null;
  week_start: string;
  status?: string | null;
  deferred_at?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
}

/**
 * The filter the one read sends: every row a question above can pick. A
 * weekly or calories card is only picked within 7 days of the phone's week, so
 * older weeks are not needed; moments and Later cards are picked by expiry,
 * whatever their week.
 */
export function dashboardCardsFilter(deviceDay: string, nowIso: string): { sinceWeek: string; nowIso: string } {
  const week = weekStartOf(deviceDay) ?? deviceDay;
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return { sinceWeek: d.toISOString().slice(0, 10), nowIso };
}

const slotOf = (r: CardRow) => (r.slot === 'calories' || r.slot === 'moment' ? r.slot : 'weekly');
const live = (r: CardRow, nowMs: number) => r.expires_at != null && Date.parse(r.expires_at) > nowMs;

export function splitDashboardCards<R extends CardRow>(
  rows: R[],
  deviceDay: string,
  nowIso: string,
): { weekly: R | null; checkin: R | null; moment: R | null; waiting: number } {
  const nowMs = Date.parse(nowIso);
  const weekly = pickCurrentCard(rows.filter((r) => slotOf(r) === 'weekly'), deviceDay);
  const checkin = pickCurrentCard(rows.filter((r) => slotOf(r) === 'calories'), deviceDay);
  let moment: R | null = null;
  for (const r of rows) {
    if (slotOf(r) !== 'moment' || r.status !== 'pending' || r.deferred_at != null || !live(r, nowMs)) continue;
    if (!moment || Date.parse(r.created_at ?? '') > Date.parse(moment.created_at ?? '')) moment = r;
  }
  const waiting = rows.filter((r) => r.status === 'pending' && r.deferred_at != null && live(r, nowMs)).length;
  return { weekly, checkin, moment, waiting };
}
