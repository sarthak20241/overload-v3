import { assertEquals } from 'jsr:@std/assert@1';
import {
  bareMAsMinutes,
  formatRoutineTarget,
  missingTargetColumn,
  parseEditorDistance,
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
  MAX_TARGET_METERS,
  MAX_TARGET_SECONDS,
  trustDistanceUnit,
  withoutTargetColumns,
  writeWithTargetFallback,
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

Deno.test('a write retries without the target columns only when they are missing', async () => {
  const missing = { code: 'PGRST204', message: "Could not find the 'target_duration_seconds' column" };
  const calls: boolean[] = [];
  // An older database: the first write fails on the column, the retry lands.
  const err = await writeWithTargetFallback((cols) => {
    calls.push(cols);
    return Promise.resolve({ error: cols ? missing : null });
  });
  assertEquals(err, null);
  assertEquals(calls, [true, false]);

  // Any other error is not retried, and is handed back.
  const other = { code: '23505', message: 'duplicate key' };
  const calls2: boolean[] = [];
  assertEquals(await writeWithTargetFallback((cols) => {
    calls2.push(cols);
    return Promise.resolve({ error: other });
  }), other);
  assertEquals(calls2, [true]);

  // A retry that fails too reports the retry's error.
  const late = { code: '42501', message: 'permission denied' };
  assertEquals(await writeWithTargetFallback((cols) => Promise.resolve({ error: cols ? missing : late })), late);
});

Deno.test('a bare m is trusted as meters only where meters make sense', () => {
  const bare = (text: string) => parseTimedTarget(text)!;
  assertEquals(trustDistanceUnit(bare('5km'), null), true);
  assertEquals(trustDistanceUnit(bare('400m'), null), false);
  assertEquals(trustDistanceUnit(bare('20m'), 'weight_distance'), true);
  assertEquals(trustDistanceUnit(bare('5m'), 'distance_duration'), false);
  assertEquals(trustDistanceUnit(bare('400m'), 'distance_duration'), true);
  assertEquals(trustDistanceUnit(bare('400m'), 'duration'), false);
});

Deno.test('the editor keeps a loaded target when it does not know the exercise type', () => {
  assertEquals(targetsFromEditor(undefined, { duration: '0:45', distance: '' }), {
    target_duration_seconds: 45,
    target_distance_m: null,
  });
  assertEquals(targetsFromEditor(null, { duration: '', distance: '' }), {
    target_duration_seconds: null,
    target_distance_m: null,
  });
});

Deno.test('a write never sends a target past the column bounds', () => {
  assertEquals(targetColumns({ target_duration_seconds: 86400, target_distance_m: 1_000_000 }), {
    target_duration_seconds: 86400,
    target_distance_m: 1_000_000,
  });
  assertEquals(targetColumns({ target_duration_seconds: 86401, target_distance_m: 1_000_001 }), {});
  assertEquals(targetColumns({ target_duration_seconds: 0.4 }), {});
});

Deno.test('the editor drops a target past the column bounds instead of showing it', () => {
  assertEquals(targetsFromEditor('distance_duration', { duration: '25:00:01', distance: '99999' }), {
    target_duration_seconds: null,
    target_distance_m: null,
  });
  assertEquals(targetsFromEditor('distance_duration', { duration: '24:00:00', distance: '1000' }), {
    target_duration_seconds: 86400,
    target_distance_m: 1_000_000,
  });
});

Deno.test('a bare m reads as minutes on a hold, and on a run below 100', () => {
  const t = parseTimedTarget('5m')!;
  assertEquals(bareMAsMinutes(t, 'duration'), { duration_seconds: 300, range: false });
  assertEquals(bareMAsMinutes(t, 'distance_duration'), { duration_seconds: 300, range: false });
  assertEquals(bareMAsMinutes(parseTimedTarget('400m')!, 'distance_duration'), parseTimedTarget('400m'));
  assertEquals(bareMAsMinutes(t, 'weight_distance'), t);
  assertEquals(bareMAsMinutes(t, null), t);
  assertEquals(bareMAsMinutes(parseTimedTarget('5km')!, 'duration'), { distance_m: 5000, range: false });
});

// The client drops a target past the CHECK bounds so a write can never fail on
// them. Keep the two in step: this reads the migration itself.
Deno.test('the client bounds match the migration CHECK bounds', async () => {
  const sql = await Deno.readTextFile(
    new URL('../supabase/migrations/20261016140000_routine_exercise_targets.sql', import.meta.url),
  );
  assertEquals(new RegExp(`target_duration_seconds between 1 and ${MAX_TARGET_SECONDS}\\b`).test(sql), true);
  assertEquals(new RegExp(`target_distance_m <= ${MAX_TARGET_METERS}\\b`).test(sql), true);
});

Deno.test('the editor Km field takes a comma decimal and never guesses', () => {
  assertEquals(parseEditorDistance('5'), 5000);
  assertEquals(parseEditorDistance('1.5'), 1500);
  assertEquals(parseEditorDistance('1,5'), 1500);
  assertEquals(parseEditorDistance('5abc'), 0);
  assertEquals(parseEditorDistance('1.5.2'), 0);
  assertEquals(parseEditorDistance(''), 0);
  assertEquals(targetsFromEditor('distance_duration', { distance: '1,5' }), {
    target_duration_seconds: null,
    target_distance_m: 1500,
  });
});
