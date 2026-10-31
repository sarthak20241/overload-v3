// deno test --allow-all lib/backgroundHolds.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { createHolds, MAX_HOLD_MS } from './backgroundHolds.ts';

function fake() {
  const calls: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    calls,
    native: { begin: () => calls.push('begin'), end: () => calls.push('end') },
    timers: {
      set: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id; },
      clear: (h: unknown) => { timers.delete(h as number); },
    },
    fireAll: () => { [...timers.values()].forEach((t) => t.fn()); },
    pending: () => [...timers.values()].map((t) => t.ms),
  };
}

Deno.test('the task ends only when the last hold lets go', () => {
  const f = fake();
  const h = createHolds(f.native, f.timers);
  const a = h.hold();
  const b = h.hold();
  a();
  a(); // twice is once
  assertEquals(f.calls.filter((c) => c === 'end').length, 0);
  b();
  assertEquals(f.calls.filter((c) => c === 'end').length, 1);
  assertEquals(h.count(), 0);
  assertEquals(f.pending(), []);
});

Deno.test('every hold asks to begin, so a task iOS expired is started again', () => {
  const f = fake();
  const h = createHolds(f.native, f.timers);
  h.hold();
  h.hold(); // the native side ignores this one while its task runs
  assertEquals(f.calls, ['begin', 'begin']);
});

Deno.test('a hold that never ends lets go by itself, so later work still gets time', () => {
  const f = fake();
  const h = createHolds(f.native, f.timers);
  h.hold(); // hangs
  assertEquals(f.pending(), [MAX_HOLD_MS]);
  f.fireAll();
  assertEquals(h.count(), 0);
  assertEquals(f.calls, ['begin', 'end']);
  const next = h.hold();
  next();
  assertEquals(f.calls, ['begin', 'end', 'begin', 'end']);
});

Deno.test('no native module: holds do nothing', () => {
  const f = fake();
  const h = createHolds(null, f.timers);
  h.hold()();
  assertEquals(h.count(), 0);
  assertEquals(f.calls, []);
});
