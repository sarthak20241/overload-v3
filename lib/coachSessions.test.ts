// deno test --allow-all lib/coachSessions.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createCoachSessionStore, MAX_KEPT, sameProps, withStableCallbacks, type CoachSessionEvent, type CoachSessionProps } from './coachSessions.ts';

type P = CoachSessionProps & { tag?: string };

function setup() {
  let t = 0;
  const store = createCoachSessionStore<P>(() => ++t);
  const events: CoachSessionEvent<P>[] = [];
  store.onEvent((e) => events.push(e));
  return { store, events };
}

Deno.test('closing an idle sheet drops it, as before', () => {
  const { store, events } = setup();
  let closed = 0;
  const id = store.open({ initialScreen: 'workout' }, () => { closed += 1; });
  store.close(id);
  assertEquals(store.getSnapshot().length, 0);
  assertEquals(closed, 1);
  assertEquals(events.length, 0);
});

Deno.test('closing a busy sheet keeps it, hidden, and says so', () => {
  const { store, events } = setup();
  const id = store.open({ initialScreen: 'workout' }, () => {});
  store.report(id, { screen: 'workout', busy: true, failed: false });
  store.close(id);
  const s = store.get(id)!;
  assertEquals(s.visible, false);
  assertEquals(events.map((e) => e.type), ['kept']);
});

Deno.test('a kept sheet that ends waits as unseen and fires finished once', () => {
  const { store, events } = setup();
  const id = store.open({ initialScreen: 'plan' }, () => {});
  store.report(id, { screen: 'plan', busy: true, failed: false });
  store.close(id);
  store.report(id, { screen: 'plan', busy: false, failed: false });
  store.report(id, { screen: 'plan', busy: false, failed: false });
  assertEquals(store.get(id)!.unseen, true);
  const finished = events.filter((e) => e.type === 'finished');
  assertEquals(finished.length, 1);
  assert(finished[0].type === 'finished' && finished[0].hidden && !finished[0].failed);
});

Deno.test('a visible sheet that ends is not unseen, but still fires finished (for a backgrounded app)', () => {
  const { store, events } = setup();
  const id = store.open({ initialScreen: 'chat' }, () => {});
  store.report(id, { screen: 'chat', busy: true, failed: false });
  store.report(id, { screen: 'chat', busy: false, failed: false });
  assertEquals(store.get(id)!.unseen, false);
  const f = events.find((e) => e.type === 'finished');
  assert(f && f.type === 'finished' && !f.hidden);
});

Deno.test('a failed run is reported as failed', () => {
  const { store, events } = setup();
  const id = store.open({ initialScreen: 'workout' }, () => {});
  store.report(id, { screen: 'workout', busy: true, failed: false });
  store.close(id);
  store.report(id, { screen: 'workout', busy: false, failed: true });
  const f = events.find((e) => e.type === 'finished');
  assert(f && f.type === 'finished' && f.failed);
});

Deno.test('opening the same kind of sheet again brings the kept one back', () => {
  const { store } = setup();
  const id = store.open({ initialScreen: 'workout' }, () => {});
  store.report(id, { screen: 'workout', busy: true, failed: false });
  store.close(id);
  const again = store.open({ initialScreen: 'workout', tag: 'new' }, () => {});
  assertEquals(again, id);
  assertEquals(store.get(id)!.visible, true);
  assertEquals(store.get(id)!.props.tag, 'new');
});

Deno.test('a phase build only comes back for the same phase', () => {
  const { store } = setup();
  const id = store.open({ initialScreen: 'plan', linkRoutinesToPhaseId: 'p1' }, () => {});
  store.report(id, { screen: 'plan', busy: true, failed: false });
  store.close(id);
  const other = store.open({ initialScreen: 'plan', linkRoutinesToPhaseId: 'p2' }, () => {});
  assert(other !== id);
  store.close(other);
  const same = store.open({ initialScreen: 'plan', linkRoutinesToPhaseId: 'p1' }, () => {});
  assertEquals(same, id);
});

Deno.test('the menu always opens fresh, so a busy build never blocks a chat', () => {
  const { store } = setup();
  const id = store.open({ initialScreen: 'plan' }, () => {});
  store.report(id, { screen: 'plan', busy: true, failed: false });
  store.close(id);
  const menu = store.open({ initialScreen: 'menu' }, () => {});
  assert(menu !== id);
  assertEquals(store.get(id)!.visible, false);
});

Deno.test('a menu pick of a kept screen hands over to the kept sheet, opener included', () => {
  const { store } = setup();
  const chat = store.open({ initialScreen: 'chat' }, () => {});
  store.report(chat, { screen: 'chat', busy: true, failed: false });
  store.close(chat);
  let closed = 0;
  const menu = store.open({ initialScreen: 'menu' }, () => { closed += 1; });
  assertEquals(store.pickScreen(menu, 'chat'), true);
  assertEquals(store.get(menu), undefined);
  assertEquals(store.get(chat)!.visible, true);
  store.report(chat, { screen: 'chat', busy: false, failed: false });
  store.close(chat);
  assertEquals(closed, 1);
  // Nothing kept on 'workout': the pick stays in the menu sheet.
  const menu2 = store.open({ initialScreen: 'menu' }, () => {});
  assertEquals(store.pickScreen(menu2, 'workout'), false);
});

Deno.test('the in-workout chat is never kept', () => {
  const { store, events } = setup();
  const id = store.open({ initialScreen: 'chat', workoutContext: { kind: 'live' } }, () => {});
  store.report(id, { screen: 'chat', busy: true, failed: false });
  store.close(id);
  assertEquals(store.get(id), undefined);
  assertEquals(events.length, 0);
});

Deno.test('only the current opener can hide or update a sheet', () => {
  const { store } = setup();
  const a = () => {};
  const b = () => {};
  const id = store.open({ initialScreen: 'workout' }, a);
  store.report(id, { screen: 'workout', busy: true, failed: false });
  store.release(id, a);
  // Opener b brings it back; a's late hide must not close b's sheet.
  assertEquals(store.open({ initialScreen: 'workout' }, b), id);
  store.release(id, a);
  store.update(id, { initialScreen: 'workout', tag: 'from-a' }, a);
  assertEquals(store.get(id)!.visible, true);
  assertEquals(store.get(id)!.props.tag, undefined);
});

Deno.test('opening a sheet closes the one showing and tells its opener', () => {
  const { store } = setup();
  let closedA = 0;
  const a = store.open({ initialScreen: 'workout' }, () => { closedA += 1; });
  store.open({ initialScreen: 'chat' }, () => {});
  assertEquals(closedA, 1);
  assertEquals(store.get(a), undefined);
});

Deno.test('show brings a kept sheet back and marks it seen', () => {
  const { store } = setup();
  const id = store.open({ initialScreen: 'workout' }, () => {});
  store.report(id, { screen: 'workout', busy: true, failed: false });
  store.close(id);
  store.report(id, { screen: 'workout', busy: false, failed: false });
  assertEquals(store.show(id), true);
  assertEquals(store.get(id)!.unseen, false);
  // Seen and idle: closing it now drops it.
  store.close(id);
  assertEquals(store.get(id), undefined);
  assertEquals(store.show(id), false);
});

Deno.test('too many kept sheets drop the oldest idle one, never a busy one', () => {
  const { store } = setup();
  const ids: number[] = [];
  for (let i = 0; i < MAX_KEPT + 1; i += 1) {
    // From the menu, so each one is fresh (a menu open never resumes).
    const id = store.open({ initialScreen: 'menu', tag: String(i) }, () => {});
    store.report(id, { screen: 'workout', busy: true, failed: false });
    store.close(id);
    ids.push(id);
  }
  // All busy: none dropped.
  assertEquals(store.getSnapshot().length, MAX_KEPT + 1);
  store.report(ids[1], { screen: 'workout', busy: false, failed: false });
  const id = store.open({ initialScreen: 'menu' }, () => {});
  store.report(id, { screen: 'program', busy: true, failed: false });
  store.close(id);
  const left = store.getSnapshot().map((s) => s.id);
  assert(!left.includes(ids[1]));
  assertEquals(left.length, MAX_KEPT + 1);
});

Deno.test('clear drops everything', () => {
  const { store } = setup();
  const id = store.open({ initialScreen: 'workout' }, () => {});
  store.report(id, { screen: 'workout', busy: true, failed: false });
  store.close(id);
  store.clear();
  assertEquals(store.getSnapshot().length, 0);
});

Deno.test('an opener re-rendering with the same props does not redraw the sheets', () => {
  const { store } = setup();
  const close = () => {};
  const cb = () => {};
  const id = store.open({ initialScreen: 'chat', tag: 'a', onX: cb } as P, close);
  let emits = 0;
  store.subscribe(() => { emits += 1; });
  store.update(id, { initialScreen: 'chat', tag: 'a', onX: cb } as P, close);
  assertEquals(emits, 0);
  store.update(id, { initialScreen: 'chat', tag: 'b', onX: cb } as P, close);
  assertEquals(emits, 1);
  assertEquals(sameProps({ a: 1 }, { a: 1, b: undefined }), false);
});

Deno.test('clear tells the opener of the sheet showing that it closed', () => {
  const { store } = setup();
  let closed = 0;
  store.open({ initialScreen: 'workout' }, () => { closed += 1; });
  store.clear();
  assertEquals(closed, 1);
  assertEquals(store.getSnapshot().length, 0);
});

Deno.test('fresh inline callbacks each render count as no change, and still call the newest one', () => {
  type Q = P & { onX?: (n: number) => number };
  const cache = new Map();
  const latest = { current: { initialScreen: 'chat', onX: (n: number) => n + 1 } as Q };
  const a = withStableCallbacks(latest.current, latest, cache);
  latest.current = { initialScreen: 'chat', onX: (n: number) => n + 100 } as Q;
  const b = withStableCallbacks(latest.current, latest, cache);
  assertEquals(sameProps(a, b), true);
  assertEquals(b.onX?.(1), 101);
  latest.current = { initialScreen: 'chat' } as Q;
  const c = withStableCallbacks(latest.current, latest, cache);
  assertEquals(c.onX, undefined);
});

Deno.test('a report for a sheet that is gone changes nothing', () => {
  const { store, events } = setup();
  const id = store.open({ initialScreen: 'workout' }, () => {});
  store.close(id);
  store.report(id, { screen: 'workout', busy: true, failed: false });
  assertEquals(store.getSnapshot().length, 0);
  assertEquals(events.length, 0);
});

Deno.test('an inline object prop with the same fields counts as no change', () => {
  assertEquals(sameProps({ planSeed: { goal: 'cut', days: '4' } }, { planSeed: { goal: 'cut', days: '4' } }), true);
  assertEquals(sameProps({ planSeed: { goal: 'cut' } }, { planSeed: { goal: 'bulk' } }), false);
  assertEquals(sameProps({ planSeed: { goal: 'cut' } }, { planSeed: { goal: 'cut', days: '4' } }), false);
  const nested = { a: [1] };
  assertEquals(sameProps({ x: { list: nested.a } }, { x: { list: nested.a } }), true);
  assertEquals(sameProps({ x: { list: [1] } }, { x: { list: [1] } }), false); // one level only
});

Deno.test('sheet ids start from the given first id, so an old run\'s notification names no sheet', () => {
  const a = createCoachSessionStore<P>(() => 1, 1000);
  const b = createCoachSessionStore<P>(() => 1, 5000);
  const idA = a.open({ initialScreen: 'chat' }, () => {});
  const idB = b.open({ initialScreen: 'chat' }, () => {});
  assertEquals(idA, 1000);
  assertEquals(b.get(idA), undefined);
  assertEquals(idB, 5000);
});
