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

Deno.test('a timed target is kept in the cue instead of turning into 8-12 reps', () => {
  assertEquals(planRepsAndNote('45s', 'Squeeze the glute'), {
    reps_min: 8,
    reps_max: 12,
    note: 'Aim for 45s. Squeeze the glute',
  });
  assertEquals(planRepsAndNote('20min'), { reps_min: 8, reps_max: 12, note: 'Aim for 20min.' });
});

// A timed row stores the table's default 8-12 reps (no time column yet), so the
// routine card must not print it as a prescription.
Deno.test('only exercises counted in reps show a rep target', () => {
  assertEquals(usesReps('duration'), false);
  assertEquals(usesReps('distance_duration'), false);
  assertEquals(usesReps('resistance_duration'), false);
  assertEquals(usesReps('weight_reps'), true);
  assertEquals(usesReps('bodyweight_reps'), true);
  assertEquals(usesReps(undefined), true);
});
