// The app's side of a food box thread (plan step 1b; server: ai-coach
// foodThreads.ts). The app makes the ids, so it never waits on the server to
// learn them, and both sides count a card's versions the same way:
//   - a new card starts at version 1, with the id the app sent as next_card_id
//   - every answer that changes the card on screen makes it base_version + 1
//   - a reply or a save card leaves the meal card's version alone
// A thread ends when its card is added (the next message tells the server),
// or after 30 minutes with no message (both sides apply that on their own).
// Only an answer the server also wrote to the thread counts as activity (a
// meal, a reply, a save card, a send still settling), never a cap or an error,
// so the two idle clocks agree. Each side measures 30 minutes on its OWN clock
// (the app from its own lastAt, the server from its own last_at), so a phone
// clock that is off does not matter. The app decides: past 30 minutes it
// starts a new thread id. The server gives a few minutes of slack, so a
// message the app sends a little past the line is still the same chat.
//
// The server ignores `thread` unless FOOD_THREADS is on or shadow, and an old
// server ignores it entirely, so SENDING it changes nothing a user sees. One
// app-side rule does, whatever the switch: a new thread (after Add, or 30 idle
// minutes, with no card on screen) starts with no earlier chat turns. That is
// deliberate (live 2026-11-06, an added lunch's turns steered a new "green
// tea" message), and it does not depend on the server.

export const THREAD_IDLE_MS = 30 * 60_000;

export interface FoodThreadState {
  id: string;
  /** The meal card on screen, as the server knows it. Null: none yet. */
  cardId: string | null;
  version: number;
  lastAt: number;
}

/** body.thread, as the server reads it (readThreadRequest). */
export interface FoodThreadSend {
  id: string;
  card_id: string | null;
  base_version: number | null;
  next_card_id: string;
  closed: { id: string; why: 'added' } | null;
}

/** What the answer did to the meal card. */
export type FoodThreadAnswer = 'meal' | 'cleared' | 'unchanged';

/** The thread for this send: the current one, or a new one when there is none
 *  or it went idle. `hasCard`: a meal card is on screen and goes with the send
 *  as previous_items. A card the thread has no id for yet (a suggestion opened
 *  as a card, a card back from a restart) gets one now, at version 1, and the
 *  server stores the app's copy under it. */
export function beginSend(
  state: FoodThreadState | null,
  o: { now: number; hasCard: boolean; ended: { id: string; why: 'added' } | null; newId: () => string },
): { state: FoodThreadState; send: FoodThreadSend; fresh: boolean } {
  const fresh = !(state && o.now - state.lastAt < THREAD_IDLE_MS);
  let s = !fresh && state ? state : { id: o.newId(), cardId: null, version: 0, lastAt: o.now };
  if (o.hasCard && !s.cardId) s = { ...s, cardId: o.newId(), version: 1 };
  if (!o.hasCard && s.cardId) s = { ...s, cardId: null, version: 0 };
  return {
    state: s,
    // A new thread: the caller starts it with no earlier turns. Live
    // 2026-11-06 a fresh "1 green tea" went out with 10 turns of an earlier,
    // already added lunch chat, and the router read it as an edit.
    fresh,
    send: {
      id: s.id,
      card_id: o.hasCard ? s.cardId : null,
      base_version: o.hasCard ? s.version : null,
      next_card_id: o.newId(),
      closed: o.ended && o.ended.id !== s.id ? o.ended : null,
    },
  };
}

/** The thread after the answer, by the same rule the server counts with. */
export function afterAnswer(state: FoodThreadState, send: FoodThreadSend, answer: FoodThreadAnswer, now: number): FoodThreadState {
  if (answer === 'cleared') return { ...state, cardId: null, version: 0, lastAt: now };
  if (answer === 'meal') {
    return send.card_id
      ? { ...state, version: state.version + 1, lastAt: now }
      : { ...state, cardId: send.next_card_id, version: 1, lastAt: now };
  }
  return { ...state, lastAt: now };
}
