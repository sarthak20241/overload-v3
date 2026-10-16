import { assertEquals } from 'jsr:@std/assert@1';
import {
  formatRoutineTarget,
  missingTargetColumn,
  parseEditorDuration,
  parseTimedTarget,
  readRoutineTargets,
  slotTargetLabel,
  takesDistanceTarget,
  takesDurationTarget,
  targetColumns,
  targetsFor,
  targetEditorText,
  targetsFromEditor,
  withoutTargetColumns,
} from './routineTargets.ts';

Deno.test('time targets parse to seconds', () => {
  assertEquals(parseTimedTarget('45s'), { duration_seconds: 45, range: false });
  assertEquals(parseTimedTarget('45 sec'), { duration_seconds: 45, range: false });
  assertEquals(parseTimedTarget('20min'), { duration_seconds: 1200, range: false });
  assertEquals(parseTimedTarget('1.5 min'), { duration_seconds: 90, range: false });
  assertEquals(parseTimedTarget('1:30'), { duration_seconds: 90, range: false });
  assertEquals(parseTimedTarget('1h'), { duration_seconds: 3600, range: false });
});

Deno.test('a range keeps its low end and says it was a range', () => {
  assertEquals(parseTimedTarget('30-45s'), { duration_seconds: 30, range: true });
  assertEquals(parseTimedTarget('30–45 s'), { duration_seconds: 30, range: true });
  assertEquals(parseTimedTarget('20 to 30 min'), { duration_seconds: 1200, range: true });
});

Deno.test('distance targets parse to meters, and a bare m is meters', () => {
  assertEquals(parseTimedTarget('5km'), { distance_m: 5000, range: false });
  assertEquals(parseTimedTarget('400m'), { distance_m: 400, range: false, bareM: true });
  assertEquals(parseTimedTarget('400 meters'), { distance_m: 400, range: false });
  assertEquals(parseTimedTarget('1 mile'), { distance_m: 1609.34, range: false });
});

Deno.test('rep counts and junk are not time or distance', () => {
  for (const t of ['8-12', '5', '8 reps', 'AMRAP', '', '45 60s', '0s', '45-30s', '45 parsecs']) {
    assertEquals(parseTimedTarget(t), null, t);
  }
});

Deno.test('reading a row fails open on missing or junk columns', () => {
  assertEquals(readRoutineTargets({ reps_min: 8 }), { target_duration_seconds: null, target_distance_m: null });
  assertEquals(readRoutineTargets(null), { target_duration_seconds: null, target_distance_m: null });
  assertEquals(readRoutineTargets({ target_duration_seconds: 45, target_distance_m: '5000' }), {
    target_duration_seconds: 45,
    target_distance_m: 5000,
  });
  assertEquals(readRoutineTargets({ target_duration_seconds: -3, target_distance_m: 'x' }), {
    target_duration_seconds: null,
    target_distance_m: null,
  });
});

Deno.test('only time and distance metric types take a target', () => {
  for (const m of ['duration', 'duration_weight', 'distance_duration', 'resistance_duration']) {
    assertEquals(takesDurationTarget(m), true, m);
  }
  assertEquals(takesDistanceTarget('distance_duration'), true);
  assertEquals(takesDurationTarget('weight_reps'), false);
  assertEquals(takesDurationTarget(undefined), false);
  assertEquals(takesDistanceTarget('duration'), false);
});

Deno.test('a write names the target columns only when a target is set', () => {
  assertEquals(targetColumns({ target_duration_seconds: null, target_distance_m: null }), {});
  assertEquals(targetColumns({ target_duration_seconds: 45 }), { target_duration_seconds: 45 });
  assertEquals(targetColumns(undefined), {});
  assertEquals(withoutTargetColumns({ sets: 3, target_duration_seconds: 45, target_distance_m: 400 }), { sets: 3 });
});

Deno.test('only a missing target column is retried without it', () => {
  assertEquals(missingTargetColumn({
    code: 'PGRST204',
    message: "Could not find the 'target_duration_seconds' column of 'routine_exercises' in the schema cache",
  }), true);
  assertEquals(missingTargetColumn({ code: '42703', message: 'column "target_distance_m" does not exist' }), true);
  assertEquals(missingTargetColumn({ code: '42703', message: 'column "superset_group" does not exist' }), false);
  assertEquals(missingTargetColumn({ code: '23514', message: 'target_duration_seconds check' }), false);
  assertEquals(missingTargetColumn(null), false);
});

Deno.test('a target reads as a short label', () => {
  assertEquals(formatRoutineTarget({ target_duration_seconds: 45, target_distance_m: null }), '0:45');
  assertEquals(formatRoutineTarget({ target_duration_seconds: 1500, target_distance_m: 5000 }), '5 km in 25:00');
  assertEquals(formatRoutineTarget({ target_duration_seconds: null, target_distance_m: null }), null);
});

Deno.test('a slot shows a target only when its exercise is measured that way', () => {
  const t = { target_duration_seconds: 45, target_distance_m: 400 };
  assertEquals(slotTargetLabel('duration', t), '0:45');
  assertEquals(slotTargetLabel('distance_duration', t), '0.4 km in 0:45');
  assertEquals(slotTargetLabel('weight_reps', t), null);
  assertEquals(slotTargetLabel(undefined, t), null);
});

Deno.test('the routine editor round-trips a target through its text fields', () => {
  const t = { target_duration_seconds: 45, target_distance_m: 5000 };
  const text = targetEditorText(t);
  assertEquals(text, { duration: '0:45', distance: '5' });
  assertEquals(targetsFromEditor('distance_duration', text), t);
  assertEquals(targetsFromEditor('duration', { duration: '45' }), { target_duration_seconds: 45, target_distance_m: null });
  assertEquals(targetEditorText({ target_duration_seconds: null, target_distance_m: null }), { duration: '', distance: '' });
});

Deno.test('the editor saves no target for an exercise that does not log one', () => {
  assertEquals(targetsFromEditor('weight_reps', { duration: '0:45', distance: '5' }), {
    target_duration_seconds: null,
    target_distance_m: null,
  });
  assertEquals(targetsFromEditor('duration', { duration: '0:00', distance: '5' }), {
    target_duration_seconds: null,
    target_distance_m: null,
  });
});

Deno.test('the editor Time field never guesses at a malformed time', () => {
  assertEquals(parseEditorDuration('0:45'), 45);
  assertEquals(parseEditorDuration('45'), 45);
  assertEquals(parseEditorDuration('45s'), 45);
  assertEquals(parseEditorDuration('1.5 min'), 90);
  assertEquals(parseEditorDuration('1.5'), 0);
  assertEquals(parseEditorDuration('abc'), 0);
  assertEquals(parseEditorDuration(''), 0);
  assertEquals(targetsFromEditor('duration', { duration: '1.5' }), { target_duration_seconds: null, target_distance_m: null });
});

Deno.test('a routine saved from a session keeps only the targets its exercise logs', () => {
  const t = { target_duration_seconds: 45, target_distance_m: 400 };
  assertEquals(targetsFor('duration', t), { target_duration_seconds: 45, target_distance_m: null });
  assertEquals(targetsFor('weight_reps', t), { target_duration_seconds: null, target_distance_m: null });
  assertEquals(targetsFor('distance_duration', {}), { target_duration_seconds: null, target_distance_m: null });
});
