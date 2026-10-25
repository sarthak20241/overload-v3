// Run with: deno test --allow-all lib/reviewPrompt.test.ts
//
// When Overload asks for a store rating. Play and Apple both cap how often the
// dialog shows, so a wasted ask (first day, a flat session) costs a real one
// later. These pin the moment: a PR, on a lifter who has come back, rarely.

import { assertEquals } from 'jsr:@std/assert@1';
import { afterSave, markAsked, parseReviewState, REVIEW_GAP_DAYS, REVIEW_MIN_DAYS, REVIEW_MIN_WORKOUTS, type ReviewState } from './reviewPrompt.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T10:00:00Z');

/** A lifter who has saved enough workouts over enough days to be asked. */
const regular: ReviewState = {
  firstSavedAt: T0,
  saved: REVIEW_MIN_WORKOUTS - 1,
  lastAskedAt: null,
};
const later = T0 + REVIEW_MIN_DAYS * DAY;

Deno.test('a PR on a returning lifter asks', () => {
  const r = afterSave(regular, { prCount: 1, now: later });
  assertEquals(r.ask, true);
  assertEquals(r.state.saved, REVIEW_MIN_WORKOUTS);
});

Deno.test('deciding to ask does not spend the ask; only showing it does', () => {
  // The dialog may never show (no native module on old binaries, app killed
  // before the share card closes), so the 90-day clock starts at markAsked.
  const r = afterSave(regular, { prCount: 1, now: later });
  assertEquals(r.state.lastAskedAt, null);
  assertEquals(afterSave(r.state, { prCount: 1, now: later + DAY }).ask, true);
  assertEquals(markAsked(r.state, later).lastAskedAt, later);
});

Deno.test('a workout with no PR never asks', () => {
  assertEquals(afterSave(regular, { prCount: 0, now: later }).ask, false);
});

Deno.test('the first save starts the clock and does not ask, even with a PR', () => {
  const r = afterSave(null, { prCount: 3, now: T0 });
  assertEquals(r.ask, false);
  assertEquals(r.state, { firstSavedAt: T0, saved: 1, lastAskedAt: null });
});

Deno.test('too few workouts does not ask', () => {
  const r = afterSave({ ...regular, saved: REVIEW_MIN_WORKOUTS - 2 }, { prCount: 1, now: later });
  assertEquals(r.ask, false);
  assertEquals(r.state.lastAskedAt, null);
});

Deno.test('enough workouts crammed into the first days does not ask', () => {
  const r = afterSave(regular, { prCount: 1, now: later - 1 });
  assertEquals(r.ask, false);
});

Deno.test('after an ask, the next one waits the full gap', () => {
  const asked = markAsked(afterSave(regular, { prCount: 1, now: later }).state, later);
  assertEquals(afterSave(asked, { prCount: 1, now: later + (REVIEW_GAP_DAYS - 1) * DAY }).ask, false);
  assertEquals(afterSave(asked, { prCount: 1, now: later + REVIEW_GAP_DAYS * DAY }).ask, true);
});

Deno.test('a clock set backwards does not count as time passed', () => {
  const asked = { ...regular, lastAskedAt: later };
  assertEquals(afterSave(asked, { prCount: 1, now: later - 400 * DAY }).ask, false);
});

Deno.test('stored state that is not the right shape reads as a fresh start', () => {
  // A bad value must not leave saved as NaN, which would block every ask.
  assertEquals(parseReviewState(null), null);
  assertEquals(parseReviewState('not json'), null);
  assertEquals(parseReviewState('{"firstSavedAt":1,"saved":"3","lastAskedAt":null}'), null);
  assertEquals(parseReviewState('{"firstSavedAt":1,"saved":3}'), null);
  assertEquals(parseReviewState('[]'), null);
  assertEquals(
    parseReviewState(JSON.stringify(regular)),
    regular,
  );
  assertEquals(
    parseReviewState('{"firstSavedAt":1,"saved":4,"lastAskedAt":9}'),
    { firstSavedAt: 1, saved: 4, lastAskedAt: 9 },
  );
});
