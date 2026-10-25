// Run with: deno test --allow-all lib/reviewPrompt.test.ts
//
// When Overload asks for a store rating. Play and Apple both cap how often the
// dialog shows, so a wasted ask (first day, a flat session) costs a real one
// later. These pin the moment: a PR, on a lifter who has come back, rarely.

import { assertEquals } from 'jsr:@std/assert@1';
import { afterSave, hasSavedPr, markAsked, parseReviewState, REVIEW_GAP_DAYS, REVIEW_MIN_DAYS, REVIEW_MIN_WORKOUTS, type ReviewState } from './reviewPrompt.ts';

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

const set = (weight_kg: number, extra: Partial<{ completed: boolean; working: boolean; is_unilateral: boolean; weight_kg_right: number | null }> = {}) =>
  ({ weight_kg, completed: true, working: true, ...extra });

Deno.test('a saved working set above the old best is a PR', () => {
  assertEquals(hasSavedPr([{ allTimeBestWeight: 100, previousSets: [], sets: [set(90), set(102.5)] }]), true);
});

Deno.test('a PR set deleted or edited down before saving is not a PR', () => {
  // The live counter went up when the set was logged; only what is saved counts.
  assertEquals(hasSavedPr([{ allTimeBestWeight: 100, previousSets: [], sets: [set(95)] }]), false);
  assertEquals(hasSavedPr([{ allTimeBestWeight: 100, previousSets: [], sets: [set(100)] }]), false);
});

Deno.test('warmups, unfinished sets and first-ever lifts are not PRs', () => {
  assertEquals(hasSavedPr([{ allTimeBestWeight: 100, previousSets: [], sets: [set(120, { working: false })] }]), false);
  assertEquals(hasSavedPr([{ allTimeBestWeight: 100, previousSets: [], sets: [set(120, { completed: false })] }]), false);
  assertEquals(hasSavedPr([{ allTimeBestWeight: null, previousSets: [], sets: [set(120)] }]), false);
});

Deno.test('last session counts as the old best when all-time is missing', () => {
  assertEquals(hasSavedPr([{ allTimeBestWeight: null, previousSets: [{ weight_kg: 60 }], sets: [set(62.5)] }]), true);
  assertEquals(hasSavedPr([{ allTimeBestWeight: null, previousSets: [{ weight_kg: 60 }], sets: [set(60)] }]), false);
});

Deno.test('the heavier side of a unilateral set counts', () => {
  assertEquals(
    hasSavedPr([{ allTimeBestWeight: 20, previousSets: [], sets: [set(18, { is_unilateral: true, weight_kg_right: 22 })] }]),
    true,
  );
});
