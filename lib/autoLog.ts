/**
 * "Just log it": the user trusts Drona, types what they ate, hits send, and
 * can close the app. The server finishes the parse and writes the diary itself
 * (supabase/functions/ai-coach/autoLog.ts). This module is the client's side
 * of that bargain:
 *
 *   - the sticky preference (lib/parseSpeed's idiom: absence of the key = off);
 *   - a "pending" list of sends the diary has not confirmed yet, written BEFORE
 *     the request goes out, so a send the app never saw answered can be
 *     reconciled on the next open and, if it truly never arrived, surfaced as
 *     "Drona didn't get: ..." with a Retry. Never re-sent silently: the user
 *     closed the app trusting it went through, so a miss has to be visible;
 *   - the per-launch memory of which diary rows Drona added, so they wear an
 *     "Added by Drona · Undo" chip until the next app launch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { newClientId } from '@/lib/syncQueue';
import { useSupabaseClient } from '@/lib/supabase';
import type { MealType } from '@/lib/foods';
import type { LoggedParseRef, LoggedSectionRef } from '@/lib/dietData';

type Supa = NonNullable<ReturnType<typeof useSupabaseClient>>;

// ── The preference ───────────────────────────────────────────────────────────

const KEY = 'overload.autoLog';

export async function getAutoLog(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY)) === 'on';
  } catch {
    // Fail closed: review mode is the safe default when storage is unreadable.
    return false;
  }
}

export async function setAutoLog(on: boolean): Promise<void> {
  try {
    if (on) await AsyncStorage.setItem(KEY, 'on');
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // Losing the preference is survivable; the user just flips it again.
  }
}

// ── Client ids ───────────────────────────────────────────────────────────────

/** A fresh uuid per send: the idempotency key on the server, the lookup key
 *  here. crypto.randomUUID when the runtime has it, else the same v4 generator
 *  the workout sync queue has used since 0038. */
export function newAutoLogClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  try {
    if (c?.randomUUID) return c.randomUUID().toLowerCase();
  } catch {
    // Fall through to the generator below.
  }
  return newClientId();
}

// Mirror of the server's sectionClientId (autoLog.ts): a meal row the send
// CREATED carries the send's id with its last two hex digits replaced by a
// per-section code. Recomputed here so a cold-start reconcile can tell "this
// send created that meal" (Undo may remove it once empty) from "it landed in a
// meal that already existed".
const SECTION_CODE: Record<MealType, string> = { breakfast: 'a0', lunch: 'a1', dinner: 'a2', snack: 'a3' };

export function sectionClientIds(clientId: string): string[] {
  const id = clientId.toLowerCase();
  return (Object.keys(SECTION_CODE) as MealType[]).map((m) => id.slice(0, -2) + SECTION_CODE[m]);
}

// ── Pending sends ────────────────────────────────────────────────────────────

export interface PendingAutoLog {
  client_id: string;
  text: string;
  /** Epoch ms of the (latest) send. A Retry resets it, so the "didn't get"
   *  line steps aside while the retry is in flight. */
  sent_at: number;
  /** The diary day the send targeted, so a Retry lands on the same day. */
  log_date: string;
}

const PENDING_KEY = 'overload.autoLog.pending';

/** Younger than this and the request is most likely still in flight; leave it. */
export const PENDING_SETTLE_MS = 5_000;
/** Older than this with nothing in the diary and the request died before the
 *  server took it (a network drop on send). Surface it; never re-send alone. */
export const PENDING_LOST_MS = 3 * 60_000;

export async function listPending(): Promise<PendingAutoLog[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr)
      ? arr.filter((p): p is PendingAutoLog =>
        !!p && typeof p.client_id === 'string' && typeof p.text === 'string' && typeof p.sent_at === 'number')
      : [];
  } catch {
    return [];
  }
}

async function writePending(list: PendingAutoLog[]): Promise<void> {
  try {
    if (list.length === 0) await AsyncStorage.removeItem(PENDING_KEY);
    else await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // A lost pending record costs the "didn't get" safety net for one send,
    // not the send itself; the server is idempotent either way.
  }
}

export async function addPending(p: PendingAutoLog): Promise<void> {
  const list = (await listPending()).filter((x) => x.client_id !== p.client_id);
  await writePending([...list, p]);
}

export async function removePending(clientId: string): Promise<void> {
  const list = await listPending();
  if (!list.some((x) => x.client_id === clientId)) return;
  await writePending(list.filter((x) => x.client_id !== clientId));
}

/** A Retry went out: restart the clock so the miss line steps aside. */
export async function touchPending(clientId: string, sentAt: number = Date.now()): Promise<void> {
  const list = await listPending();
  await writePending(list.map((x) => (x.client_id === clientId ? { ...x, sent_at: sentAt } : x)));
}

// ── What Drona added this launch ─────────────────────────────────────────────

// Entry id -> the whole send's ref. The row chip's Undo undoes the SEND (every
// row it wrote), which is the action the user is undoing; removing one line is
// what tapping the row already does. In memory only: "until the next app
// launch" is exactly a module-level Map's lifetime.
const addedThisLaunch = new Map<string, LoggedParseRef>();

export function markAddedByDrona(ref: LoggedParseRef): void {
  for (const s of ref.sections) for (const id of s.entryIds) addedThisLaunch.set(id, ref);
}

export function addedByDronaRef(entryId: string): LoggedParseRef | null {
  return addedThisLaunch.get(entryId) ?? null;
}

export function forgetAddedByDrona(ref: LoggedParseRef): void {
  for (const s of ref.sections) for (const id of s.entryIds) addedThisLaunch.delete(id);
}

// ── Reconcile ────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  /** Sends the diary confirms. Already removed from pending and marked as
   *  added by Drona; the caller refreshes the day. */
  found: { pending: PendingAutoLog; ref: LoggedParseRef }[];
  /** Sends older than PENDING_LOST_MS with nothing in the diary. */
  lost: PendingAutoLog[];
}

/** Look every settled pending send up by client_id. Runs on foreground and on
 *  the nutrition screen's mount, which is how a send the app never saw answered
 *  (force-quit mid-stream) turns into rows with a chip, or into a visible miss. */
export async function reconcilePending(supabase: Supa, now: number = Date.now()): Promise<ReconcileResult> {
  const out: ReconcileResult = { found: [], lost: [] };
  const pending = await listPending();
  for (const p of pending) {
    const age = now - p.sent_at;
    if (age < PENDING_SETTLE_MS) continue;
    const ref = await lookupSend(supabase, p.client_id);
    if (ref === undefined) continue; // query failed (offline): leave it for next time
    if (ref) {
      markAddedByDrona(ref);
      await removePending(p.client_id);
      out.found.push({ pending: p, ref });
    } else if (age >= PENDING_LOST_MS) {
      out.lost.push(p);
    }
  }
  return out;
}

/** The rows one send wrote, as an Undo ref. null = nothing in the diary for
 *  this id; undefined = could not ask (treat as unknown, not as missing). */
export async function lookupSend(supabase: Supa, clientId: string): Promise<LoggedParseRef | null | undefined> {
  const { data: entries, error } = await supabase
    .from('meal_entries').select('id, meal_id').eq('client_id', clientId);
  if (error) return undefined;
  if (!entries || entries.length === 0) return null;
  const byMeal = new Map<string, string[]>();
  for (const e of entries as { id: string; meal_id: string }[]) {
    byMeal.set(e.meal_id, [...(byMeal.get(e.meal_id) ?? []), e.id]);
  }
  const { data: meals, error: mealsErr } = await supabase
    .from('meals').select('id, meal_type, client_id').in('id', [...byMeal.keys()]);
  if (mealsErr) return undefined;
  const created = new Set(sectionClientIds(clientId));
  const sections: LoggedSectionRef[] = ((meals ?? []) as { id: string; meal_type: MealType; client_id: string | null }[])
    .map((m) => ({
      mealType: m.meal_type,
      mealId: m.id,
      entryIds: byMeal.get(m.id) ?? [],
      createdMeal: !!m.client_id && created.has(m.client_id.toLowerCase()),
    }));
  return { sections };
}
