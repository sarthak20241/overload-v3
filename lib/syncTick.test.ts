// deno test --allow-all lib/syncTick.test.ts
//
// Screens re-read the server only when syncedTick moves. It must move whenever
// a flush put something on the server, even if a new save kept the count level.
import { assertEquals } from 'jsr:@std/assert@1';
import { nextSyncCounts } from './syncTick.ts';

const at = (pendingCount: number, syncedTick = 0) => ({ pendingCount, syncedTick });

Deno.test('a local save (the queue grows) does not move the tick', () => {
  assertEquals(nextSyncCounts(at(0), 1, 0), { counts: at(1), synced: false });
});

Deno.test('a flush that empties the queue moves the tick', () => {
  assertEquals(nextSyncCounts(at(1), 0, 1), { counts: at(0, 1), synced: true });
});

Deno.test('a save during a flush keeps the count level, and the flush still moves the tick', () => {
  // One workout landed, another was saved while it did: 1 -> 1.
  assertEquals(nextSyncCounts(at(1, 4), 1, 1), { counts: at(1, 5), synced: true });
});

Deno.test('nothing landed and nothing changed: no new state at all', () => {
  const prev = at(2, 3);
  const next = nextSyncCounts(prev, 2, 0);
  assertEquals(next.synced, false);
  assertEquals(next.counts === prev, true);
});

Deno.test('a drop with nothing flushed (a queued item removed here) still re-reads', () => {
  assertEquals(nextSyncCounts(at(2), 1, 0), { counts: at(1, 1), synced: true });
});
