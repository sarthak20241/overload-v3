import { assertEquals } from 'jsr:@std/assert@1';
import {
  COACH_FORM_SESSION_OPTIONS,
  CUSTOM_SESSION_MAX,
  CUSTOM_SESSION_MIN,
  SESSION_LENGTH_OPTIONS,
  coachFormSessionChoices,
  coachFormSessionOption,
  customSessionSub,
  isPresetSessionMinutes,
  sessionMinutesValue,
} from './sessionLength.ts';
import { sessionCap } from '../supabase/functions/ai-coach/sessionTime.ts';

Deno.test('every onboarding answer survives a build from the coach form', () => {
  // The form opens on a range, the server reads the range back from the
  // request words, and the saved number inside it must win: a 20 minute user
  // who taps Build without touching the dropdown still gets 20 minutes.
  for (const { minutes } of SESSION_LENGTH_OPTIONS) {
    const option = coachFormSessionOption(minutes);
    assertEquals(COACH_FORM_SESSION_OPTIONS.includes(option), true, option);
    const phaseRequest = `Design my training split. x Keep sessions about ${option}, Beginner level.`;
    const plainRequest = `Design a multi-day training plan for me. Goal: x. 4 days/week, ${option} sessions, Beginner level.`;
    assertEquals(sessionCap({ profileMinutes: minutes, request: phaseRequest }), minutes, option);
    assertEquals(sessionCap({ profileMinutes: minutes, request: plainRequest }), minutes, option);
  }
});

Deno.test('a user who picks a longer range in the form gets it', () => {
  assertEquals(sessionCap({ profileMinutes: 20, request: 'x Keep sessions about 60-75 min, Beginner level.' }), 75);
});

Deno.test('no saved length keeps the old form default', () => {
  assertEquals(coachFormSessionOption(null), '45-60 min');
  assertEquals(coachFormSessionOption('20'), '45-60 min');
});

Deno.test('only what the database check accepts is saved', () => {
  assertEquals(sessionMinutesValue(20), 20);
  assertEquals(sessionMinutesValue(9), null);
  assertEquals(sessionMinutesValue(181), null);
  assertEquals(sessionMinutesValue(Number.NaN), null);
});

// 2026-11-28: the onboarding step has a Custom choice (any whole minute the
// database takes, 10 to 180). A custom time must reach the plan exactly.
Deno.test('a custom time survives a build from the coach form', () => {
  for (const minutes of [10, 15, 19, 25, 40, 50, 70, 91, 120, 180]) {
    const option = coachFormSessionOption(minutes);
    assertEquals(coachFormSessionChoices(minutes).includes(option), true, option);
    const phaseRequest = `Design my training split. x Keep sessions about ${option}, Beginner level.`;
    const plainRequest = `Design a multi-day training plan for me. Goal: x. 4 days/week, ${option} sessions, Beginner level.`;
    assertEquals(sessionCap({ profileMinutes: minutes, request: phaseRequest }), minutes, option);
    assertEquals(sessionCap({ profileMinutes: minutes, request: plainRequest }), minutes, option);
  }
});

Deno.test('the form lists a custom time only when no range holds it', () => {
  assertEquals(coachFormSessionChoices(15), ['15 min', ...COACH_FORM_SESSION_OPTIONS]);
  assertEquals(coachFormSessionChoices(120), [...COACH_FORM_SESSION_OPTIONS, '120 min']);
  assertEquals(coachFormSessionChoices(50), COACH_FORM_SESSION_OPTIONS);
  assertEquals(coachFormSessionChoices(null), COACH_FORM_SESSION_OPTIONS);
});

Deno.test('the cards start at 30 minutes; 20 is a Custom time', () => {
  assertEquals(SESSION_LENGTH_OPTIONS.map((o) => o.minutes), [30, 45, 60, 90]);
  assertEquals(isPresetSessionMinutes(20), false);
  assertEquals(customSessionSub(20), '20 minutes');
});

Deno.test('the Custom card: lit for a time that is not a preset, with its number', () => {
  assertEquals(isPresetSessionMinutes(45), true);
  assertEquals(isPresetSessionMinutes(50), false);
  assertEquals(customSessionSub(50), '50 minutes');
  assertEquals(customSessionSub(45), 'Set your own minutes');
  assertEquals(CUSTOM_SESSION_MIN, 10);
  assertEquals(CUSTOM_SESSION_MAX, 180);
});
