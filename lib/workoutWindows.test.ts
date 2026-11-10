// deno test --allow-all lib/workoutWindows.test.ts
//
// Analytics shows 180 days of workouts. It now reads the newest 90 from the
// read the dashboard and History share, and only the older 90 itself. These
// tests pin that the two halves put together are the list one 180-day read
// gave: every workout once, newest first.
import { assertEquals } from 'jsr:@std/assert@1';
import { mergeWorkoutWindows, olderWindow } from './workoutWindows.ts';

const w = (id: string, started_at: string, extra: { name?: string } = {}): { id: string; started_at: string; name?: string } => ({ id, started_at, ...extra });

Deno.test('the two halves join into one newest-first list', () => {
  const recent = [w('c', '2026-10-20T08:00:00Z'), w('b', '2026-08-01T08:00:00Z')];
  const older = [w('a', '2026-06-01T08:00:00Z')];
  assertEquals(mergeWorkoutWindows(recent, older).map((x) => x.id), ['c', 'b', 'a']);
});

Deno.test('a workout in the overlap shows once, as the shared read has it', () => {
  // The older read reaches a day past the shared read's start, so nothing can
  // fall between the two; a workout in that day comes back from both.
  const recent = [w('b', '2026-07-25T08:00:00Z', { name: 'Push (edited)' })];
  const older = [w('b', '2026-07-25T08:00:00Z', { name: 'Push' }), w('a', '2026-06-01T08:00:00Z')];
  const merged = mergeWorkoutWindows(recent, older);
  assertEquals(merged.map((x) => [x.id, x.name]), [['b', 'Push (edited)'], ['a', undefined]]);
});

Deno.test('order is by start time even when an older-half row is newer than a shared one', () => {
  // A row the shared read missed (it landed after that read) can sort between.
  const recent = [w('c', '2026-10-20T08:00:00Z'), w('b', '2026-07-26T08:00:00Z')];
  const older = [w('x', '2026-07-26T09:00:00Z'), w('a', '2026-06-01T08:00:00Z')];
  assertEquals(mergeWorkoutWindows(recent, older).map((x) => x.id), ['c', 'x', 'b', 'a']);
});

Deno.test('the older window covers 180 days back to one day past the 90-day line', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const { sinceIso, beforeIso } = olderWindow(now);
  assertEquals(sinceIso, new Date(now - 180 * 86_400_000).toISOString());
  assertEquals(beforeIso, new Date(now - 89 * 86_400_000).toISOString());
});
