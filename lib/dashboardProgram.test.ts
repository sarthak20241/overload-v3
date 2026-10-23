// deno test --allow-all --unstable-sloppy-imports --import-map=lib/test-import-map.json lib/dashboardProgram.test.ts
//
// The dashboard's TODAY card and movement-goals row used to read
// coach_programs + phases themselves. They now take the program
// lib/programData already reads. These tests pin that what they get is the
// same as what their own reads produced.
import { assertEquals } from 'jsr:@std/assert@1';
import { activityTargetsFrom, pickProgramFrom, type DashboardProgramSource } from './dashboardProgram.ts';
import { weekPatternFor } from './weekPattern.ts';

const block = (days: number) => ({ split_type: 'Upper/Lower', days_per_week: days });

/** An active program as loadActiveProgram returns it (only the fields read here). */
const program = (startDate: string): DashboardProgramSource => ({
  id: 'prog-1',
  start_date: startDate,
  phases: [
    { id: 'ph-a', seq: 0, duration_weeks: 2, start_offset_weeks: 0, training_block: block(4), activity_steps_target: 8000, cardio_sessions_per_week: null },
    { id: 'ph-b', seq: 1, duration_weeks: 3, start_offset_weeks: 2, training_block: null, activity_steps_target: null, cardio_sessions_per_week: 2 },
    { id: 'ph-c', seq: 2, duration_weeks: 1, start_offset_weeks: 5, training_block: block(3), activity_steps_target: 250_000, cardio_sessions_per_week: 99 },
  ],
});

Deno.test('the TODAY pick gets the same program shape its own read built', () => {
  const p = pickProgramFrom(program('2026-10-01'));
  // Exactly these keys, and the week pattern resolved the way the old read
  // resolved it: this is also the shape cached on disk as 'activeProgram'.
  assertEquals(p, {
    id: 'prog-1',
    start_date: '2026-10-01',
    phases: [
      { id: 'ph-a', duration_weeks: 2, start_offset_weeks: 0, week_pattern: weekPatternFor(block(4)) },
      { id: 'ph-b', duration_weeks: 3, start_offset_weeks: 2, week_pattern: null },
      { id: 'ph-c', duration_weeks: 1, start_offset_weeks: 5, week_pattern: weekPatternFor(block(3)) },
    ],
  });
});

Deno.test('no active program is no program for the pick', () => {
  assertEquals(pickProgramFrom(null), null);
});

Deno.test('movement goals come from the phase active TODAY, by date', () => {
  // Day 0..13 is phase a (steps only).
  assertEquals(activityTargetsFrom(program('2026-10-01'), '2026-10-01'), { stepsTarget: 8000, cardioTarget: null });
  // Day 14 starts phase b (cardio only).
  assertEquals(activityTargetsFrom(program('2026-10-01'), '2026-10-15'), { stepsTarget: null, cardioTarget: 2 });
  // Phase c: both clamped into range, as the old read clamped them.
  assertEquals(activityTargetsFrom(program('2026-10-01'), '2026-11-05'), { stepsTarget: 30_000, cardioTarget: 7 });
});

Deno.test('before the start, after the end, or no goals: nothing to show', () => {
  assertEquals(activityTargetsFrom(program('2026-10-01'), '2026-09-30'), null);
  assertEquals(activityTargetsFrom(program('2026-10-01'), '2026-11-12'), null);
  assertEquals(activityTargetsFrom(null, '2026-10-01'), null);
  const none = program('2026-10-01');
  none.phases[0] = { ...none.phases[0], activity_steps_target: null };
  assertEquals(activityTargetsFrom(none, '2026-10-01'), null);
});

Deno.test('a program read yesterday still answers for today, not for the day it was read', () => {
  // A cached program carries the phase that was current when it was read;
  // the row must follow the date, as its own read did on every focus.
  const p = { ...program('2026-10-01'), currentPhaseSeq: 0 } as DashboardProgramSource & { currentPhaseSeq: number };
  assertEquals(activityTargetsFrom(p, '2026-10-15'), { stepsTarget: null, cardioTarget: 2 });
});
