/**
 * The app's side of the daily-suggestion function: read today's saved TODAY
 * pick, or ask the server to make it when there is none (or it is stale).
 *
 * Everything here fails soft. A missing table, row or function, no signal, or
 * no token all come back as null, and the dashboard picks on the phone instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAccessToken } from '@/lib/supabase';

export interface SavedSuggestion {
  day: string;
  kind: 'planned' | 'rest' | 'new';
  routine_id: string | null;
  resumes_on: string | null;
  scheduled: boolean;
  basis: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** The device's IANA time zone, or null when the runtime cannot say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Local calendar day, YYYY-MM-DD. */
export function localDayISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const asSaved = (row: any): SavedSuggestion | null =>
  row && typeof row.day === 'string' && ['planned', 'rest', 'new'].includes(row.kind)
    ? {
        day: row.day,
        kind: row.kind,
        routine_id: row.routine_id ?? null,
        resumes_on: row.resumes_on ?? null,
        scheduled: !!row.scheduled,
        basis: String(row.basis ?? ''),
      }
    : null;

/**
 * Today's saved pick. `undefined` = the read failed (offline, or the table is
 * not there yet): do not treat that as "no pick", or every blip re-requests.
 */
export async function readSavedSuggestion(
  supabase: SupabaseClient,
  clerkId: string,
  day: string,
): Promise<SavedSuggestion | null | undefined> {
  try {
    const { data, error } = await supabase
      .from('daily_suggestions')
      .select('day, kind, routine_id, resumes_on, scheduled, basis')
      .eq('user_id', clerkId)
      .eq('day', day)
      .maybeSingle();
    if (error) return undefined;
    return asSaved(data);
  } catch {
    return undefined;
  }
}

/** Ask the server to make (or remake) today's pick. Null on any failure. */
export async function requestSuggestion(timeZone: string): Promise<SavedSuggestion | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const token = await getSupabaseAccessToken();
    if (!token) return null;
    const res = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/daily-suggestion`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'app', tz: timeZone }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return asSaved(body?.suggestion);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
