import { assertEquals } from 'jsr:@std/assert@1';
import { type ProfileReader, readCronDays } from './cronUsers.ts';

// 2026-10-25 20:00 UTC is already 2026-10-26 in Kolkata.
const NOW = new Date('2026-10-25T20:00:00Z');

type Row = { clerk_user_id: string | null; timezone: string | null };

/**
 * An in-memory user_profiles that answers the way PostgREST does: filters,
 * order, then the range. `not`/`is` filters are honoured, so a read that
 * drops users with no zone drops them here too.
 */
function profiles(rows: Row[], reads: number[][] = []): ProfileReader {
  const query = (filters: ((r: Row) => boolean)[]) => {
    const q = {
      select: () => q,
      not: (col: keyof Row, op: 'is', value: null) => query([...filters, (r) => !(op === 'is' && r[col] === value)]),
      is: (col: keyof Row, value: null) => query([...filters, (r) => r[col] === value]),
      order: (col: keyof Row, { ascending }: { ascending: boolean }) => ({
        range: (from: number, to: number) => {
          reads.push([from, to]);
          const sorted = rows.filter((r) => filters.every((f) => f(r)))
            .sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (ascending ? 1 : -1));
          return Promise.resolve({ data: sorted.slice(from, to + 1), error: null, status: 200 });
        },
      }),
    };
    return q;
  };
  return { from: () => query([]) } as unknown as ProfileReader;
}

Deno.test('readCronDays: a user with no saved zone gets a UTC day, not skipped', async () => {
  const read = await readCronDays(profiles([
    { clerk_user_id: 'u1', timezone: 'Asia/Kolkata' },
    { clerk_user_id: 'u2', timezone: null },
    { clerk_user_id: 'u3', timezone: 'Not/AZone' },
  ]), NOW);
  assertEquals(read, {
    users: [
      { userId: 'u1', tz: 'Asia/Kolkata', day: '2026-10-26' },
      { userId: 'u2', tz: 'UTC', day: '2026-10-25' },
      { userId: 'u3', tz: 'UTC', day: '2026-10-25' },
    ],
  });
});

Deno.test('readCronDays: pages past the first page', async () => {
  const reads: number[][] = [];
  const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ clerk_user_id: id, timezone: null }));
  const read = await readCronDays(profiles(rows, reads), NOW, 2);
  assertEquals('users' in read && read.users.map((u) => u.userId), ['a', 'b', 'c', 'd', 'e']);
  assertEquals(reads, [[0, 1], [2, 3], [4, 5]]);
});

Deno.test('readCronDays: a failed read is an error, not an empty run', async () => {
  const db = {
    from: () => ({
      select: () => ({
        order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'bad column' }, status: 400 }) }),
      }),
    }),
  } as unknown as ProfileReader;
  assertEquals(await readCronDays(db, NOW), { error: 'bad column' });
});
