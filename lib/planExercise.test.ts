import { assertEquals } from 'jsr:@std/assert@1';
import { parseNewExercise, planExerciseInsert, planRepsAndNote } from './planExercise.ts';

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

Deno.test('a timed target is kept in the cue instead of turning into 8-12 reps', () => {
  assertEquals(planRepsAndNote('45s', 'Squeeze the glute'), {
    reps_min: 8,
    reps_max: 12,
    note: 'Aim for 45s. Squeeze the glute',
  });
  assertEquals(planRepsAndNote('20min'), { reps_min: 8, reps_max: 12, note: 'Aim for 20min.' });
});
