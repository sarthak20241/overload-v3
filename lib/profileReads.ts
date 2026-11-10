/**
 * The user's profile row, goal history and one-day goals, each read once and
 * shared through lib/screenCache. At app start the dashboard, the fuel targets
 * (every useNutritionTargets), readiness, the analytics person properties and
 * the Profile screen each read user_profiles with their own columns; now they
 * take their columns from one `select('*')` of the row. The same goes for
 * user_target_history and user_day_targets (fuel targets and readiness).
 *
 * Keys, under one prefix so a write clears all three:
 *   profile:<clerkId>            the user_profiles row (null = no row yet)
 *   profile:<clerkId>:history    user_target_history, oldest first
 *   profile:<clerkId>:days:<d>   user_day_targets from DAY_TARGETS_BACK days before d
 *
 * Every write to these tables from the app calls invalidateProfile, and so
 * does a sync flush (award_xp moves xp) and a Drona card move. The window
 * only bounds how late a change made elsewhere (a server job, another device)
 * shows up. A failed read is never stored: it throws, and callers keep what
 * they had.
 *
 * Pure apart from the cache (no React, no client import), so
 * `deno test lib/profileReads.test.ts` covers it with a fake client.
 */
import { fetchShared, invalidate } from './screenCache';

/** How long a read row is used as it is. */
export const PROFILE_FRESH_MS = 30_000;
/** One-day goals are read this many days back (the diary's reach without paging). */
export const DAY_TARGETS_BACK = 90;

// The client as far as these reads need it; a real SupabaseClient fits.
// deno-lint-ignore no-explicit-any
type Supa = { from: (table: string) => any };
type Opts = { fresh?: boolean };

const win = (opts?: Opts) => (opts?.fresh ? undefined : { maxAgeMs: PROFILE_FRESH_MS });

function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const t = new Date(y, m - 1, d + delta);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** The user's user_profiles row (every column), or null when there is none. Throws on a failed read. */
export function loadProfileRow(supabase: Supa, clerkId: string, opts?: Opts): Promise<Record<string, unknown> | null> {
  return fetchShared(`profile:${clerkId}`, async () => {
    const { data, error } = await supabase.from('user_profiles').select('*').eq('clerk_user_id', clerkId).maybeSingle();
    if (error) throw error;
    return (data as Record<string, unknown> | null) ?? null;
  }, win(opts));
}

export interface HistoryRow {
  effective_from: string;
  kcal: number | string | null;
  protein_g: number | string | null;
  carb_g: number | string | null;
  fat_g: number | string | null;
  calorie_day_boosts?: unknown;
}

/** The goal as it stood from each date on (user_target_history), oldest first. Throws on a failed read (a database before 0150 too). */
export function loadTargetHistory(supabase: Supa, clerkId: string, opts?: Opts): Promise<HistoryRow[]> {
  return fetchShared(`profile:${clerkId}:history`, async () => {
    const { data, error } = await supabase.from('user_target_history')
      .select('effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts')
      .eq('user_id', clerkId)
      .order('effective_from', { ascending: true });
    if (error) throw error;
    return (data ?? []) as HistoryRow[];
  }, win(opts));
}

export interface DayGoalRow {
  day: string;
  kcal: number | string;
  protein_g: number | string | null;
  carb_g: number | string | null;
  fat_g: number | string | null;
}

/**
 * Goals set for one day only (user_day_targets), from DAY_TARGETS_BACK days
 * before `todayISO` on. Throws on a failed read (a database before 0151 too).
 */
export function loadDayGoals(supabase: Supa, clerkId: string, todayISO: string, opts?: Opts): Promise<DayGoalRow[]> {
  return fetchShared(`profile:${clerkId}:days:${todayISO}`, async () => {
    const { data, error } = await supabase.from('user_day_targets')
      .select('day, kcal, protein_g, carb_g, fat_g')
      .eq('user_id', clerkId)
      .gte('day', addDaysISO(todayISO, -DAY_TARGETS_BACK));
    if (error) throw error;
    return (data ?? []) as DayGoalRow[];
  }, win(opts));
}

/**
 * A write changed the profile row, the goal history (a trigger keeps it with
 * the row) or a one-day goal: the next read of any of them goes to the
 * server. Without an id, every user's (a write that does not know whose, such
 * as a card move; only the signed-in user's is ever cached). Readiness reads
 * the targets too, so it goes with them.
 */
export function invalidateProfile(clerkId?: string | null): void {
  invalidate(clerkId ? `profile:${clerkId}` : 'profile');
  invalidate(clerkId ? `readiness:${clerkId}` : 'readiness');
}
