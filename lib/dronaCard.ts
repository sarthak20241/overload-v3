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
import { pickCurrentCard, weekStartOf } from '@/lib/dronaRules';

export type DronaCardKind = 'request' | 'notice' | 'act' | 'talk';
export type DronaCardStatus = 'pending' | 'applied' | 'dismissed' | 'undone' | 'opened' | 'done' | 'expired' | 'held';

/**
 * What the card's button does. `route` is legacy and never trusted: the phone
 * maps the ACTION to a screen (see ACTION_ROUTES). The swap fields name the
 * routine slot a swap card changes, so the card can show what it did.
 */
export interface DronaCardPayload {
  action?: string;
  route?: string;
  routine_id?: string;
  routine_exercise_id?: string;
  from_exercise_id?: string;
  to_exercise_id?: string;
  from_name?: string;
  to_name?: string;
  routine_name?: string;
  /** apply_targets: the four numbers the card saw, so Undo can put them back. */
  from_kcal?: number;
  to_kcal?: number;
  from_protein_g?: number | null;
  from_carb_g?: number | null;
  from_fat_g?: number | null;
  phase_id?: string | null;
}

export interface SavedDronaCard {
  id: string;
  week_start: string;
  kind: DronaCardKind;
  topic: string;
  title: string;
  body: string;
  evidence: { label: string; value: string }[];
  payload: DronaCardPayload;
  status: DronaCardStatus;
  /** Set when the user tapped Later. The popup skips it; From Drona lists it. */
  deferred_at: string | null;
  /** Set on Later: the end of the card's week, in the user's zone. */
  expires_at: string | null;
  decided_at: string | null;
  created_at: string | null;
}

const REQUEST_TIMEOUT_MS = 10_000;
const CARD_COLUMNS =
  'id, week_start, kind, topic, title, body, evidence, payload, status, deferred_at, expires_at, decided_at, created_at';
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
        deferred_at: typeof row.deferred_at === 'string' ? row.deferred_at : null,
        expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
        decided_at: typeof row.decided_at === 'string' ? row.decided_at : null,
        created_at: typeof row.created_at === 'string' ? row.created_at : null,
      }
    : null;

/**
 * The current card: the newest one within a week either side of the phone's
 * own week (see pickCurrentCard for why the phone must not insist on its own).
 * `undefined` = the read failed (offline, or the table is not there yet): do
 * not treat that as "no card", or every blip re-requests.
 */
export async function readWeeklyCard(
  supabase: SupabaseClient,
  clerkId: string,
  now: Date = new Date(),
): Promise<SavedDronaCard | null | undefined> {
  try {
    const { data, error } = await supabase
      .from('drona_cards')
      .select(CARD_COLUMNS)
      .eq('user_id', clerkId)
      .order('week_start', { ascending: false })
      .limit(3);
    if (error) return undefined;
    return asCard(pickCurrentCard(data ?? [], localDayISO(now)));
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

/**
 * The swap card's two moves (migration 0124). The database owns both: it
 * changes the routine only while the slot still holds what the card claims,
 * and it moves the card's status itself. So the phone sends a card id and
 * nothing else, and cannot change a routine by sending a made-up exercise.
 *
 * Returns the database's word for what happened, or null when the call failed.
 * 'moved_on' means the user already edited that routine by hand; their edit
 * stands and nothing was touched.
 */
async function swapMove(
  supabase: SupabaseClient,
  fn: 'drona_apply_swap' | 'drona_undo_swap' | 'drona_apply_targets' | 'drona_undo_targets',
  cardId: string,
): Promise<string | null> {
  try {
    // Tag the write so the plan change log says a CARD changed the plan, not
    // the user's own hand (migration 0123 reads these headers in its trigger).
    const request = supabase.rpc(fn, { p_card_id: cardId });
    const taggable = request as unknown as { setHeader?: (name: string, value: string) => void };
    taggable.setHeader?.('x-change-source', 'card');
    taggable.setHeader?.('x-change-card', cardId);
    const { data, error } = await request;
    if (error) return null;
    return typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
}

/** "Make it the plan" on a swap act card. */
export const applySwap = (supabase: SupabaseClient, cardId: string) =>
  swapMove(supabase, 'drona_apply_swap', cardId);

/** "Undo" on the notice that follows a swap Drona applied by itself. */
export const undoSwap = (supabase: SupabaseClient, cardId: string) =>
  swapMove(supabase, 'drona_undo_swap', cardId);

/** Later: the card leaves the dashboard and waits on From Drona until its week ends. */
export async function deferCard(supabase: SupabaseClient, cardId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc('drona_defer_card', { p_card_id: cardId });
    if (error) return null;
    return typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Every card the user has, newest first, for the From Drona screen. Which pile
 * each one goes in is lib/dronaInbox's call. `undefined` = the read failed.
 */
export async function readCardHistory(
  supabase: SupabaseClient,
  clerkId: string,
  limit = 40,
): Promise<SavedDronaCard[] | undefined> {
  try {
    const { data, error } = await supabase
      .from('drona_cards')
      .select(CARD_COLUMNS)
      .eq('user_id', clerkId)
      .order('week_start', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return undefined;
    return (data ?? []).map(asCard).filter((c): c is SavedDronaCard => c != null);
  } catch {
    return undefined;
  }
}

/** "Set 1950 kcal" on a calories act card (B1). The database re-derives the macros. */
export const applyTargets = (supabase: SupabaseClient, cardId: string) =>
  swapMove(supabase, 'drona_apply_targets', cardId);

/** Undo on a calories card: the four numbers it saw go back, seven days. */
export const undoTargets = (supabase: SupabaseClient, cardId: string) =>
  swapMove(supabase, 'drona_undo_targets', cardId);

/** Which move a card's action wants, so one handler serves swaps and targets. */
export function movesFor(action?: string): { apply: typeof applySwap; undo: typeof undoSwap } | null {
  if (action === 'apply_swap' || action === 'undo_swap') return { apply: applySwap, undo: undoSwap };
  if (action === 'apply_targets') return { apply: applyTargets, undo: undoTargets };
  return null;
}
