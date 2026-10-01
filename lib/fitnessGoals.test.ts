import { assertEquals } from 'jsr:@std/assert@1';
import { goalLabels, primaryGoal, selectedGoals, toggleGoal } from './fitnessGoals.ts';

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
