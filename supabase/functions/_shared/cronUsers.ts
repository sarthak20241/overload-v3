// Every user a cron run works on, with their local day. Unit-tested in
// cronUsers.test.ts against an in-memory user_profiles.

import { cronDays } from './wallClock.ts';
import { retried } from './retried.ts';

type ProfileRow = { clerk_user_id: string | null; timezone: string | null };
type Page = { data: ProfileRow[] | null; error: { message: string } | null; status?: number };

/** The slice of a supabase-js client this read uses. */
export interface ProfileReader {
  from(table: 'user_profiles'): {
    select(cols: 'clerk_user_id, timezone'): {
      order(col: 'clerk_user_id', opts: { ascending: boolean }): {
        range(from: number, to: number): PromiseLike<Page>;
      };
    };
  };
}

/**
 * Read every profile and give each one a local day. No timezone filter on the
 * read: a user with no saved zone is read in UTC (cronDays), not skipped.
 * PostgREST caps a read at 1000 rows, so this pages through, or users past
 * the first thousand silently never get a run.
 */
export async function readCronDays(
  db: ProfileReader,
  now: Date,
  page = 1000,
): Promise<{ users: { userId: string; tz: string; day: string }[] } | { error: string }> {
  const rows: ProfileRow[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await retried(() =>
      db.from('user_profiles').select('clerk_user_id, timezone')
        .order('clerk_user_id', { ascending: true }).range(from, from + page - 1)
    );
    if (error) return { error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return { users: cronDays(rows, now) };
}
