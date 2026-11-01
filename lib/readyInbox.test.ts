// deno test --allow-all --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/readyInbox.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { createReadyInbox, isStaleCoachItem, openInboxItem, parseStored, readyInbox, storable, type InboxItem } from './readyInbox.ts';
import { inboxIdFor, readyTargetFromData } from './readyNotice.ts';

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => Promise.resolve(m.get(k) ?? null),
    setItem: (k: string, v: string) => { m.set(k, v); return Promise.resolve(); },
  };
}

const phase: Omit<InboxItem, 'at'> = {
  id: 'phase:p1', title: 'Phase 2 is ready', body: 'b', target: { route: '/goal-plan' },
};
const coach: Omit<InboxItem, 'at'> = {
  id: 'coach:3', title: 'Your workout is ready.', body: 'b', target: { coachSession: 3 },
};

Deno.test('adding the same thing twice keeps one, moved to the top', async () => {
  const inbox = createReadyInbox(memory());
  await inbox.hydrate('u1');
  inbox.add({ ...phase, at: 1 });
  inbox.add({ ...coach, at: 2 });
  inbox.add({ ...phase, title: 'Phase 2 is ready again', at: 3 });
  assertEquals(inbox.getSnapshot().map((i) => i.id), ['phase:p1', 'coach:3']);
  assertEquals(inbox.getSnapshot()[0].title, 'Phase 2 is ready again');
});

Deno.test('a kept coach sheet is never stored: it does not survive the app', async () => {
  const store = memory();
  const inbox = createReadyInbox(store);
  await inbox.hydrate('u1');
  inbox.add(phase);
  inbox.add(coach);
  const again = createReadyInbox(store);
  await again.hydrate('u1');
  assertEquals(again.getSnapshot().map((i) => i.id), ['phase:p1']);
});

Deno.test('each user sees only their own items', async () => {
  const store = memory();
  const inbox = createReadyInbox(store);
  await inbox.hydrate('u1');
  inbox.add(phase);
  await inbox.hydrate('u2');
  assertEquals(inbox.getSnapshot().length, 0);
  await inbox.hydrate(null);
  assertEquals(inbox.getSnapshot().length, 0);
  await inbox.hydrate('u1');
  assertEquals(inbox.getSnapshot().length, 1);
});

Deno.test('remove and removeWhere take items out and save', async () => {
  const store = memory();
  const inbox = createReadyInbox(store);
  await inbox.hydrate('u1');
  inbox.add(phase);
  inbox.add({ ...phase, id: 'meal', target: { route: '/nutrition' } });
  inbox.remove('meal');
  inbox.removeWhere((i) => i.id.startsWith('phase:'));
  assertEquals(inbox.getSnapshot().length, 0);
  assertEquals(parseStored(store.m.get('ready_inbox_v1:u1') ?? null).length, 0);
});

Deno.test('a malformed store reads as empty', () => {
  assertEquals(parseStored('not json'), []);
  assertEquals(parseStored('{"a":1}'), []);
  assertEquals(parseStored('[{"id":1}]'), []);
  assertEquals(storable([{ ...coach, at: 1 }]), []);
});

Deno.test('loading the same user again keeps what is there (a root remount)', async () => {
  const inbox = createReadyInbox(memory());
  await inbox.hydrate('u1');
  inbox.add(coach);
  await inbox.hydrate('u1');
  assertEquals(inbox.getSnapshot().map((i) => i.id), ['coach:3']);
  await inbox.hydrate(null);
  inbox.add(phase);
  await inbox.hydrate(null);
  assertEquals(inbox.getSnapshot().map((i) => i.id), ['phase:p1']);
});

Deno.test('a sheet item stays while the sheet waits unseen, and goes once it shows or is gone', () => {
  const item = { ...coach, at: 1 };
  assertEquals(isStaleCoachItem(item, [{ id: 3, visible: false }]), false);
  assertEquals(isStaleCoachItem(item, [{ id: 3, visible: true }]), true);
  assertEquals(isStaleCoachItem(item, []), true);
  assertEquals(isStaleCoachItem({ ...phase, at: 1 }, []), false);
});

Deno.test('a notice for an open sheet is not filed; a hidden one is', () => {
  const target = { coachSession: 3 };
  assertEquals(inboxIdFor({ title: 't', body: 'b', target }), 'coach:3');
  assertEquals(inboxIdFor({ title: 't', body: 'b', target, inbox: false }), null);
  assertEquals(inboxIdFor({ title: 't', body: 'b', target: { route: '/nutrition' }, inbox: 'meal' }), 'meal');
});

Deno.test('a notification only routes to an app path', () => {
  assertEquals(readyTargetFromData({ route: '/goal-plan' }), { route: '/goal-plan' });
  assertEquals(readyTargetFromData({ route: '//evil.example' }), null);
  assertEquals(readyTargetFromData({ route: 'https://x' }), null);
  assertEquals(readyTargetFromData({ route: '/\\evil' }), null);
  assertEquals(readyTargetFromData({ route: '/goal-plan?build=phase&seq=1&auto=1' }), { route: '/goal-plan?build=phase&seq=1&auto=1' });
  assertEquals(readyTargetFromData({ coachSession: 4, route: '//x' }), { coachSession: 4, route: undefined });
});

Deno.test('an item added while the stored list loads does not overwrite it', async () => {
  const store = memory();
  const first = createReadyInbox(store);
  await first.hydrate('u1');
  first.add({ ...phase, at: 1 });
  // A slow read: the add lands before it returns.
  let finish: (v: string | null) => void = () => {};
  const slow = {
    getItem: (k: string) => new Promise<string | null>((r) => { finish = r; void store.getItem(k); }),
    setItem: store.setItem,
  };
  const inbox = createReadyInbox(slow);
  const loading = inbox.hydrate('u1');
  inbox.add({ ...phase, id: 'meal', target: { route: '/nutrition' }, at: 2 });
  assertEquals(parseStored(store.m.get('ready_inbox_v1:u1') ?? null).map((i) => i.id), ['phase:p1']);
  finish(store.m.get('ready_inbox_v1:u1') ?? null);
  await loading;
  assertEquals(inbox.getSnapshot().map((i) => i.id), ['meal', 'phase:p1']);
  assertEquals(parseStored(store.m.get('ready_inbox_v1:u1') ?? null).map((i) => i.id), ['meal', 'phase:p1']);
});

Deno.test('opening a phase item keeps it until the phase is saved; other items leave as they open', async () => {
  await readyInbox.hydrate('open-test');
  readyInbox.add({ ...phase, keepUntilDone: true });
  readyInbox.add({ id: 'meal', title: 'm', body: 'b', target: { route: '/nutrition' } });
  const pushed: string[] = [];
  for (const item of [...readyInbox.getSnapshot()]) openInboxItem(item, (r) => pushed.push(r));
  assertEquals(pushed, ['/nutrition', '/goal-plan']);
  assertEquals(readyInbox.getSnapshot().map((i) => i.id), ['phase:p1']);
});

Deno.test('a stored list that could not be read is never saved over', async () => {
  const store = memory();
  const first = createReadyInbox(store);
  await first.hydrate('u1');
  first.add({ ...phase, at: 1 });
  const broken = { getItem: () => Promise.reject(new Error('disk')), setItem: store.setItem };
  const inbox = createReadyInbox(broken);
  await inbox.hydrate('u1');
  inbox.add({ ...phase, id: 'meal', target: { route: '/nutrition' }, at: 2 });
  assertEquals(parseStored(store.m.get('ready_inbox_v1:u1') ?? null).map((i) => i.id), ['phase:p1']);
});

Deno.test('news from start-up (before sign-in is known) stays with the account that loads', async () => {
  const store = memory();
  const inbox = createReadyInbox(store);
  await inbox.hydrate(null); // Clerk still loading
  inbox.add({ ...phase, at: 1 });
  await inbox.hydrate('u1');
  assertEquals(inbox.getSnapshot().map((i) => i.id), ['phase:p1']);
  assertEquals(parseStored(store.m.get('ready_inbox_v1:u1') ?? null).map((i) => i.id), ['phase:p1']);
  // Another account: the last one's news goes.
  await inbox.hydrate('u2');
  assertEquals(inbox.getSnapshot().length, 0);
});

Deno.test('a failed read is tried again on the next change, so later items are saved', async () => {
  const store = memory();
  const first = createReadyInbox(store);
  await first.hydrate('u1');
  first.add({ ...phase, at: 1 });
  let fail = true;
  const flaky = {
    getItem: (k: string) => (fail ? Promise.reject(new Error('disk')) : store.getItem(k)),
    setItem: store.setItem,
  };
  const inbox = createReadyInbox(flaky);
  await inbox.hydrate('u1');
  fail = false;
  inbox.add({ ...phase, id: 'meal', target: { route: '/nutrition' }, at: 2 });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(parseStored(store.m.get('ready_inbox_v1:u1') ?? null).map((i) => i.id), ['meal', 'phase:p1']);
});

Deno.test('an item removed while the stored list loads stays removed', async () => {
  const store = memory();
  const first = createReadyInbox(store);
  await first.hydrate('u1');
  first.add({ ...phase, at: 1 });
  first.add({ id: 'meal', title: 'm', body: 'b', target: { route: '/nutrition' }, at: 2 });
  let finish: (v: string | null) => void = () => {};
  const slow = {
    getItem: () => new Promise<string | null>((r) => { finish = r; }),
    setItem: store.setItem,
  };
  const inbox = createReadyInbox(slow);
  const loading = inbox.hydrate('u1');
  inbox.remove('phase:p1');
  inbox.removeWhere((i) => i.id === 'meal');
  finish(store.m.get('ready_inbox_v1:u1') ?? null);
  await loading;
  assertEquals(inbox.getSnapshot().length, 0);
});
