// Run with: deno test --allow-all lib/foodThread.test.ts
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { afterAnswer, beginSend, THREAD_IDLE_MS } from './foodThread.ts';

let n = 0;
const newId = () => `id-${++n}`;

Deno.test('Nov 5 thread: log, correct, save card, bring back; versions match the server rule', () => {
  n = 0;
  const t0 = 1_000_000;
  // 1. First message: no card yet.
  let { state, send } = beginSend(null, { now: t0, hasCard: false, ended: null, newId });
  assertEquals([send.card_id, send.base_version], [null, null]);
  state = afterAnswer(state, send, 'meal', t0);
  assertEquals([state.cardId, state.version], [send.next_card_id, 1]);
  const lunch = state.cardId;
  // 2. A correction: v1 -> v2, same card.
  ({ state, send } = beginSend(state, { now: t0 + 60_000, hasCard: true, ended: null, newId }));
  assertEquals([send.card_id, send.base_version], [lunch, 1]);
  state = afterAnswer(state, send, 'meal', t0 + 60_000);
  assertEquals([state.cardId, state.version], [lunch, 2]);
  // 3. "save this sabji": a save card. The meal card keeps v2.
  ({ state, send } = beginSend(state, { now: t0 + 120_000, hasCard: true, ended: null, newId }));
  state = afterAnswer(state, send, 'unchanged', t0 + 120_000);
  assertEquals([state.cardId, state.version], [lunch, 2]);
  // 4. Still the same thread.
  const again = beginSend(state, { now: t0 + 180_000, hasCard: true, ended: null, newId });
  assertEquals([again.send.id, again.send.card_id, again.send.base_version], [state.id, lunch, 2]);
});

Deno.test('a thread idle 30 minutes is replaced by a new one', () => {
  n = 0;
  const first = beginSend(null, { now: 0, hasCard: false, ended: null, newId }).state;
  const later = beginSend(first, { now: THREAD_IDLE_MS + 1, hasCard: false, ended: null, newId });
  assertNotEquals(later.send.id, first.id);
});

Deno.test('after Add, the next send starts a new thread and closes the old one', () => {
  n = 0;
  const old = beginSend(null, { now: 0, hasCard: false, ended: null, newId }).state;
  const next = beginSend(null, { now: 1000, hasCard: false, ended: { id: old.id, why: 'added' }, newId });
  assertNotEquals(next.send.id, old.id);
  assertEquals(next.send.closed, { id: old.id, why: 'added' });
});

Deno.test('a card on screen with no thread id gets one at v1; removing the last line clears it', () => {
  n = 0;
  let { state, send } = beginSend(null, { now: 0, hasCard: true, ended: null, newId });
  assertEquals(send.base_version, 1);
  state = afterAnswer(state, send, 'cleared', 10);
  assertEquals([state.cardId, state.version], [null, 0]);
});
