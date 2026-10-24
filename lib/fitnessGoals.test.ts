import { assertEquals } from 'jsr:@std/assert@1';
import { goalLabels, joinGoals, missingGoalsColumn, primaryGoal, profileGoalFields, programGoalFor, selectedGoals, toggleGoal } from './fitnessGoals.ts';

Deno.test('muscle, fat loss and strength remain selected together', () => {
  let a = toggleGoal({ goals: [] }, 'hypertrophy');
  a = toggleGoal(a, 'fat_loss');
  a = toggleGoal(a, 'strength');
  assertEquals(a.goals, ['hypertrophy', 'fat_loss', 'strength']);
  assertEquals(a.goal, 'hypertrophy');
  assertEquals(goalLabels(a), 'build muscle, lose fat, get stronger');
});

Deno.test('deselecting a goal preserves the others and updates the primary', () => {
  const a = toggleGoal({ goals: ['hypertrophy', 'fat_loss', 'strength'] }, 'hypertrophy');
  assertEquals(a.goals, ['fat_loss', 'strength']);
  assertEquals(primaryGoal(a), 'fat_loss');
  assertEquals(toggleGoal(a, 'strength').goals, ['fat_loss']);
});

Deno.test('the last goal can be deselected so Continue can be disabled', () => {
  const a = toggleGoal({ goals: ['strength'] }, 'strength');
  assertEquals(a.goals, []);
  assertEquals(a.goal, null);
  assertEquals(selectedGoals(a), []);
});

Deno.test('legacy intakes and profiles retain their scalar goal', () => {
  assertEquals(selectedGoals({ goal: 'strength' }), ['strength']);
  assertEquals(toggleGoal({ goal: 'strength' }, 'fat_loss').goals, ['strength', 'fat_loss']);
  assertEquals(selectedGoals({ goals: null, goal: 'hypertrophy' }), ['hypertrophy']);
});

Deno.test('invalid goals and duplicates never reach plan labels', () => {
  assertEquals(selectedGoals({ goals: ['strength', 'strength', '__proto__', 'constructor', 7] }), ['strength']);
  assertEquals(selectedGoals({ goals: [], goal: 'strength' }), []);
});

Deno.test('legacy retry only covers a missing goals column', () => {
  assertEquals(missingGoalsColumn({ code: 'PGRST204', message: "Could not find the 'goals' column" }), true);
  assertEquals(missingGoalsColumn({ code: '42703', message: 'column user_profiles.goals does not exist' }), true);
  assertEquals(missingGoalsColumn({ code: '42703', message: 'column timezone does not exist' }), false);
  assertEquals(missingGoalsColumn({ code: '42501', message: 'goals permission denied' }), false);
});

Deno.test('commitment copy joins goals naturally', () => {
  assertEquals(joinGoals(['Building muscle', 'getting stronger']), 'Building muscle and getting stronger');
  assertEquals(joinGoals(['Building muscle', 'losing fat', 'getting stronger']), 'Building muscle, losing fat, and getting stronger');
});

// The live rows that started this (2026-10-16): cuts saved as 'hypertrophy'.
Deno.test('a program that takes weight down is fat_loss whatever the profile says', () => {
  assertEquals(programGoalFor('hypertrophy', 59.5, 65.5), 'fat_loss');
  assertEquals(programGoalFor('hypertrophy', 62, 67.5), 'fat_loss');
  assertEquals(programGoalFor('hypertrophy', 75, 82), 'fat_loss');
  assertEquals(programGoalFor('strength', 70, 71), 'fat_loss');
  assertEquals(programGoalFor('endurance', 70, 78), 'fat_loss');
});

Deno.test('a gain is never fat_loss, and a gain keeps its training goal', () => {
  assertEquals(programGoalFor('fat_loss', 76, 70), 'hypertrophy');
  assertEquals(programGoalFor('strength', 76, 70), 'strength');
  assertEquals(programGoalFor('hypertrophy', 76, 70), 'hypertrophy');
});

Deno.test('no weight target, or under 1 kg of change, keeps the given goal (recomp)', () => {
  assertEquals(programGoalFor('hypertrophy', undefined, 80), 'hypertrophy');
  assertEquals(programGoalFor('hypertrophy', 79.5, 80), 'hypertrophy');
  assertEquals(programGoalFor('fat_loss', 80.5, 80), 'fat_loss');
  assertEquals(programGoalFor('strength', 70, null), 'strength');
  assertEquals(programGoalFor('strength', 70, 0), 'strength');
});

Deno.test('an unknown goal becomes general, unless the weight says cut', () => {
  assertEquals(programGoalFor(undefined, undefined, 80), 'general');
  assertEquals(programGoalFor('__proto__', undefined, 80), 'general');
  assertEquals(programGoalFor('recomp', 72, 80), 'fat_loss');
});

Deno.test('a goal written in their own words with no card saves general, like the program', () => {
  assertEquals(profileGoalFields({ goals: [], goalNote: 'Run a half marathon in March' }), { goal: 'general', goals: ['general'] });
  assertEquals(profileGoalFields({ goals: ['strength'], goalNote: 'Run a 5k' }), { goal: 'strength', goals: ['strength'] });
  assertEquals(profileGoalFields({ goals: [], goalNote: '   ' }), null);
  assertEquals(profileGoalFields({ goals: [], goalNote: null }), null);
});
