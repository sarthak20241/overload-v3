import { assertEquals } from 'jsr:@std/assert@1';
import { parseNewExercise, planExerciseInsert, planRepsAndNote } from './planExercise.ts';
import { usesReps } from './exercises.ts';

Deno.test('an invented exercise is inserted with its own template, not Other', () => {
  const new_exercise = parseNewExercise({ muscle_group: 'Hip Flexors', category: 'Bodyweight', metric_type: 'duration' });
  assertEquals(planExerciseInsert({ name: 'Couch Stretch', new_exercise }), {
    name: 'Couch Stretch',
    muscle_group: 'Hip Flexors',
    category: 'Bodyweight',
    metric_type: 'duration',
  });
});

Deno.test('a plain catalog name keeps the bare insert', () => {
  assertEquals(planExerciseInsert({ name: 'Bench Press' }), {
    name: 'Bench Press',
    muscle_group: 'Other',
    category: 'Other',
  });
});

Deno.test('a malformed template from an older server is re-checked, not trusted', () => {
  assertEquals(parseNewExercise('duration'), undefined);
  assertEquals(parseNewExercise({ metric_type: 'not_a_type', muscle_group: 42 }), {
    muscle_group: 'Other',
    category: 'Other',
    metric_type: 'weight_reps',
  });
});

Deno.test('rep targets fill the rep columns as before', () => {
  assertEquals(planRepsAndNote('6-10', 'RIR 2'), { reps_min: 6, reps_max: 10, note: 'RIR 2' });
  assertEquals(planRepsAndNote('5'), { reps_min: 5, reps_max: 5, note: null });
  assertEquals(planRepsAndNote('8-12 reps', ''), { reps_min: 8, reps_max: 12, note: null });
});

Deno.test('a rep range with extra words keeps its numbers and its words', () => {
  assertEquals(planRepsAndNote('10-12/side', 'Slow down'), {
    reps_min: 10,
    reps_max: 12,
    note: 'Aim for 10-12/side. Slow down',
  });
  assertEquals(planRepsAndNote('6-8 each'), { reps_min: 6, reps_max: 8, note: 'Aim for 6-8 each.' });
  assertEquals(planRepsAndNote('AMRAP'), { reps_min: 8, reps_max: 12, note: 'Aim for AMRAP.' });
  assertEquals(planRepsAndNote('3x10'), { reps_min: 10, reps_max: 10, note: 'Aim for 3x10.' });
  assertEquals(planRepsAndNote('3 x 8-12'), { reps_min: 8, reps_max: 12, note: 'Aim for 3 x 8-12.' });
});

Deno.test('a 45s stretch saves 45 seconds to the time column, not the cue', () => {
  assertEquals(planRepsAndNote('45s', 'Squeeze the glute'), {
    reps_min: 8,
    reps_max: 12,
    note: 'Squeeze the glute',
    target_duration_seconds: 45,
  });
  assertEquals(planRepsAndNote('20min'), { reps_min: 8, reps_max: 12, note: null, target_duration_seconds: 1200 });
});

Deno.test('a timed range stores its low end and keeps the range in the cue', () => {
  assertEquals(planRepsAndNote('30-45s', 'Breathe out'), {
    reps_min: 8,
    reps_max: 12,
    note: 'Aim for 30-45s. Breathe out',
    target_duration_seconds: 30,
  });
});

Deno.test('a distance target saves meters to the distance column', () => {
  assertEquals(planRepsAndNote('5km', 'Easy pace'), {
    reps_min: 8,
    reps_max: 12,
    note: 'Easy pace',
    target_distance_m: 5000,
  });
  assertEquals(planRepsAndNote('400m'), { reps_min: 8, reps_max: 12, note: null, target_distance_m: 400 });
});

Deno.test('a rep target never names the target columns', () => {
  const row = planRepsAndNote('8-12', 'RIR 2');
  assertEquals('target_duration_seconds' in row || 'target_distance_m' in row, false);
});

Deno.test('against a database without the columns, the target rides in the cue', () => {
  assertEquals(planRepsAndNote('45s', 'Squeeze the glute', { targetColumns: false }), {
    reps_min: 8,
    reps_max: 12,
    note: 'Aim for 45s. Squeeze the glute',
  });
  assertEquals(planRepsAndNote('AMRAP'), { reps_min: 8, reps_max: 12, note: 'Aim for AMRAP.' });
});

// A timed row stores the table's default 8-12 reps when it has no target, so the
// routine card must not print it as a prescription.
Deno.test('only exercises counted in reps show a rep target', () => {
  assertEquals(usesReps('duration'), false);
  assertEquals(usesReps('distance_duration'), false);
  assertEquals(usesReps('resistance_duration'), false);
  assertEquals(usesReps('weight_reps'), true);
  assertEquals(usesReps('bodyweight_reps'), true);
  assertEquals(usesReps(undefined), true);
});

Deno.test('a time on an exercise that does not log time stays in the cue', () => {
  assertEquals(planRepsAndNote('30s', 'Brace', { metricType: 'weight_reps' }), {
    reps_min: 8,
    reps_max: 12,
    note: 'Aim for 30s. Brace',
  });
  assertEquals(planRepsAndNote('5km', null, { metricType: 'duration' }), { reps_min: 8, reps_max: 12, note: 'Aim for 5km.' });
  assertEquals(planRepsAndNote('45s', null, { metricType: 'duration' }), {
    reps_min: 8,
    reps_max: 12,
    note: null,
    target_duration_seconds: 45,
  });
});
