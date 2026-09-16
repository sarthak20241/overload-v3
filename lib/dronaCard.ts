/**
 * The app's side of the weekly Drona card: read this week's card, ask the
 * server for one when there is none, and record what the user did with it.
 *
 * Everything fails soft. A missing table, row or function, no signal or no
 * token all come back as null, and the dashboard simply shows no card.
 * The rules that CHOOSE the card live on the server (_shared/dronaCards.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAccessToken } from '@/lib/supabase';
import { localDayISO } from '@/lib/dailySuggestion';
import { weekStartOf } from '@/lib/dronaRules';

export type DronaCardKind = 'request' | 'notice' | 'act' | 'talk';
export type DronaCardStatus = 'pending' | 'applied' | 'dismissed' | 'opened' | 'done' | 'expired' | 'held';

export interface SavedDronaCard {
  id: string;
  week_start: string;
  kind: DronaCardKind;
  topic: string;
  title: string;
  body: string;
  evidence: { label: string; value: string }[];
  payload: { action?: string; route?: string };
  status: DronaCardStatus;
}

const REQUEST_TIMEOUT_MS = 10_000;
const KINDS: DronaCardKind[] = ['request', 'notice', 'act', 'talk'];

/** The Monday of the device's current local week. */
export function currentWeekStart(now: Date = new Date()): string {
  return weekStartOf(localDayISO(now)) ?? localDayISO(now);
}

const asCard = (row: any): SavedDronaCard | null =>
  row && typeof row.id === 'string' && KINDS.includes(row.kind)
    ? {
        id: row.id,
        week_start: String(row.week_start ?? ''),
        kind: row.kind,
        topic: String(row.topic ?? ''),
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        evidence: Array.isArray(row.evidence) ? row.evidence.filter((e: any) => e?.label && e?.value != null) : [],
        payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
        status: row.status ?? 'pending',
      }
    : null;

/**
 * This week's card. `undefined` = the read failed (offline, or the table is not
 * there yet): do not treat that as "no card", or every blip re-requests.
 */
export async function readWeeklyCard(
  supabase: SupabaseClient,
  clerkId: string,
  weekStart: string,
): Promise<SavedDronaCard | null | undefined> {
  try {
    const { data, error } = await supabase
      .from('drona_cards')
      .select('id, week_start, kind, topic, title, body, evidence, payload, status')
      .eq('user_id', clerkId)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (error) return undefined;
    return asCard(data);
  } catch {
    return undefined;
  }
}

/**
 * Ask the server to decide this week's card. Null on any failure, and null is
 * also the honest answer when the week has nothing worth saying (a hold).
 */
export async function requestWeeklyCard(timeZone: string | null): Promise<SavedDronaCard | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const token = await getSupabaseAccessToken();
    if (!token) return null;
    const res = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/drona-cards`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'app', ...(timeZone ? { tz: timeZone } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return asCard(json?.card);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Record what the user did with the card. Only the status is writable. */
export async function setCardStatus(
  supabase: SupabaseClient,
  cardId: string,
  status: DronaCardStatus,
): Promise<void> {
  try {
    await supabase
      .from('drona_cards')
      .update({ status, decided_at: new Date().toISOString() })
      .eq('id', cardId);
  } catch {
    // The card is already off the screen; a failed write means it comes back
    // next open, which is better than blocking the tap.
  }
}
