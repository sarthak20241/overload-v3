// deno test --allow-all lib/screenCache.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { clearCache, fetchShared, invalidate, peek, prune, put, resetForTest, setClockForTest } from './screenCache.ts';

const later = <T,>(v: T) => {
  let resolve!: (x: T) => void;
  const p = new Promise<T>((r) => { resolve = r; });
  return { p, done: () => resolve(v) };
};

Deno.test('a read is stored, and peek returns it at once', async () => {
  resetForTest();
  assertEquals(peek('program:u1'), undefined);
  const v = await fetchShared('program:u1', () => Promise.resolve({ id: 'p1' }));
  assertEquals(v, { id: 'p1' });
  assertEquals(peek('program:u1'), { id: 'p1' });
});

Deno.test('a null answer is stored too: "no program" is a known state, not a miss', async () => {
  resetForTest();
  await fetchShared('program:u1', () => Promise.resolve(null));
  assertEquals(peek('program:u1'), null);
});

Deno.test('two screens asking at once share one read', async () => {
  resetForTest();
  let calls = 0;
  const gate = later({ id: 'p1' });
  const fn = () => { calls += 1; return gate.p; };
  const a = fetchShared('program:u1', fn);
  const b = fetchShared('program:u1', fn);
  gate.done();
  assertEquals(await a, await b);
  assertEquals(calls, 1);
});

Deno.test('a read that started before a write is not stored over it', async () => {
  resetForTest();
  await fetchShared('program:u1', () => Promise.resolve({ id: 'old' }));
  const gate = later({ id: 'stale' });
  const pending = fetchShared('program:u1', () => gate.p);
  invalidate('program:u1'); // the user logged a value meanwhile
  gate.done();
  assertEquals(await pending, { id: 'stale' }); // the caller still gets its answer
  assertEquals(peek('program:u1'), undefined); // but the cache does not keep it
  // The next read starts fresh instead of joining the stale one.
  assertEquals(await fetchShared('program:u1', () => Promise.resolve({ id: 'new' })), { id: 'new' });
  assertEquals(peek('program:u1'), { id: 'new' });
});

Deno.test('invalidate by prefix clears one user, not the others', async () => {
  resetForTest();
  await fetchShared('pillar:week:u1:2026-10-19', () => Promise.resolve(1));
  await fetchShared('pillar:nights:u1:2026-10-23', () => Promise.resolve(2));
  await fetchShared('pillar:week:u2:2026-10-19', () => Promise.resolve(3));
  invalidate('pillar:week:u1');
  assertEquals(peek('pillar:week:u1:2026-10-19'), undefined);
  assertEquals(peek('pillar:nights:u1:2026-10-23'), 2);
  assertEquals(peek('pillar:week:u2:2026-10-19'), 3);
});

Deno.test('a failed read stores nothing and keeps the last good value', async () => {
  resetForTest();
  await fetchShared('program:u1', () => Promise.resolve({ id: 'good' }));
  let threw = false;
  try { await fetchShared('program:u1', () => Promise.reject(new Error('offline'))); } catch { threw = true; }
  assertEquals(threw, true);
  assertEquals(peek('program:u1'), { id: 'good' });
});

Deno.test('invalidate matches whole key segments: user_1 never clears user_10', async () => {
  resetForTest();
  await fetchShared('program:user_1', () => Promise.resolve('a'));
  await fetchShared('program:user_10', () => Promise.resolve('b'));
  await fetchShared('pillar:routines:user_1:r1,r2', () => Promise.resolve('c'));
  await fetchShared('pillar:routines:user_10:r3', () => Promise.resolve('d'));
  invalidate('program:user_1');
  invalidate('pillar:routines:user_1');
  assertEquals(peek('program:user_1'), undefined);
  assertEquals(peek('program:user_10'), 'b');
  assertEquals(peek('pillar:routines:user_1:r1,r2'), undefined);
  assertEquals(peek('pillar:routines:user_10:r3'), 'd');
});

Deno.test('clearCache empties everything (sign-out)', async () => {
  resetForTest();
  await fetchShared('program:u1', () => Promise.resolve('a'));
  clearCache();
  assertEquals(peek('program:u1'), undefined);
});

// ---- Freshness window (maxAgeMs) -------------------------------------------

Deno.test('inside maxAgeMs a stored value answers with no read', async () => {
  resetForTest();
  let t = 1_000;
  setClockForTest(() => t);
  let calls = 0;
  const fn = () => { calls += 1; return Promise.resolve({ id: `p${calls}` }); };
  assertEquals(await fetchShared('program:u1', fn, { maxAgeMs: 30_000 }), { id: 'p1' });
  t += 29_999;
  assertEquals(await fetchShared('program:u1', fn, { maxAgeMs: 30_000 }), { id: 'p1' });
  assertEquals(calls, 1);
  // Past the window: read again, and the new answer is stored.
  t += 2;
  assertEquals(await fetchShared('program:u1', fn, { maxAgeMs: 30_000 }), { id: 'p2' });
  assertEquals(calls, 2);
  assertEquals(peek('program:u1'), { id: 'p2' });
});

Deno.test('a stored null is fresh too: "no program" is not re-read inside the window', async () => {
  resetForTest();
  setClockForTest(() => 5);
  let calls = 0;
  const fn = () => { calls += 1; return Promise.resolve(null); };
  await fetchShared('program:u1', fn, { maxAgeMs: 1_000 });
  assertEquals(await fetchShared('program:u1', fn, { maxAgeMs: 1_000 }), null);
  assertEquals(calls, 1);
});

Deno.test('without maxAgeMs every call reads (the old behaviour)', async () => {
  resetForTest();
  setClockForTest(() => 0);
  let calls = 0;
  const fn = () => { calls += 1; return Promise.resolve(calls); };
  await fetchShared('program:u1', fn);
  await fetchShared('program:u1', fn);
  assertEquals(calls, 2);
});

Deno.test('a write inside the window still forces the next read', async () => {
  resetForTest();
  setClockForTest(() => 0);
  let calls = 0;
  const fn = () => { calls += 1; return Promise.resolve(calls); };
  await fetchShared('program:u1', fn, { maxAgeMs: 60_000 });
  invalidate('program:u1');
  assertEquals(await fetchShared('program:u1', fn, { maxAgeMs: 60_000 }), 2);
});

Deno.test('put stores a value a write just computed, and a read already in flight does not overwrite it', async () => {
  resetForTest();
  setClockForTest(() => 0);
  const gate = later('before-the-write');
  const pending = fetchShared('readiness:u1:2026-10-23', () => gate.p);
  put('readiness:u1:2026-10-23', 'computed-by-the-write');
  gate.done();
  assertEquals(await pending, 'before-the-write');
  assertEquals(peek('readiness:u1:2026-10-23'), 'computed-by-the-write');
  // And it counts as fresh.
  let calls = 0;
  const v = await fetchShared('readiness:u1:2026-10-23', () => { calls += 1; return Promise.resolve('x'); }, { maxAgeMs: 1_000 });
  assertEquals([v, calls], ['computed-by-the-write', 0]);
});

Deno.test('prune drops the older days of one kind and keeps the rest, without dropping reads in flight', async () => {
  resetForTest();
  await fetchShared('pillar:nights:u1:2026-10-21', () => Promise.resolve(1));
  await fetchShared('pillar:nights:u1:2026-10-22', () => Promise.resolve(2));
  await fetchShared('pillar:nights:u2:2026-10-21', () => Promise.resolve(3));
  await fetchShared('pillar:week:u1:2026-10-19', () => Promise.resolve(4));
  const gate = later('today');
  const pending = fetchShared('pillar:nights:u1:2026-10-23', () => gate.p);
  prune('pillar:nights:u1', 'pillar:nights:u1:2026-10-23');
  gate.done();
  await pending;
  assertEquals(peek('pillar:nights:u1:2026-10-21'), undefined);
  assertEquals(peek('pillar:nights:u1:2026-10-22'), undefined);
  assertEquals(peek('pillar:nights:u1:2026-10-23'), 'today'); // pruning is not a write: the read is still stored
  assertEquals(peek('pillar:nights:u2:2026-10-21'), 3);
  assertEquals(peek('pillar:week:u1:2026-10-19'), 4);
});

Deno.test('put only blocks reads of its own key: a read of another key in flight is still stored', async () => {
  resetForTest();
  const gate = later({ id: 'p1' });
  const pending = fetchShared('program:u1', () => gate.p);
  put('readiness:u1:2026-10-23', 'computed');
  gate.done();
  await pending;
  assertEquals(peek('program:u1'), { id: 'p1' });
});

Deno.test('after a put, a new caller does not join the older read of that key', async () => {
  resetForTest();
  const gate = later('before-the-write');
  fetchShared('readiness:u1:2026-10-23', () => gate.p);
  put('readiness:u1:2026-10-23', 'computed');
  const v = fetchShared('readiness:u1:2026-10-23', () => Promise.resolve('read-after-the-write'));
  gate.done();
  assertEquals(await v, 'read-after-the-write');
});
