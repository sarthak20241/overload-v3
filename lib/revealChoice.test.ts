import { assertEquals } from 'jsr:@std/assert@1';
import { REVEAL_CHOICES, revealChoiceFor } from './revealChoice.ts';

Deno.test('Save my plan: keeps the plan and opens the dashboard path', () => {
  assertEquals(REVEAL_CHOICES.plan, { createPlan: true, dest: '/(app)' });
});

Deno.test("I'll build my own routines: still keeps Drona's plan", () => {
  assertEquals(REVEAL_CHOICES.own_routines.createPlan, true);
});

Deno.test("I'll build my own routines: lands on Routines", () => {
  assertEquals(REVEAL_CHOICES.own_routines.dest, '/(app)/routines');
});

Deno.test('reveal_choice: each button maps back to its name', () => {
  assertEquals(revealChoiceFor(REVEAL_CHOICES.plan.dest), 'plan');
  assertEquals(revealChoiceFor(REVEAL_CHOICES.own_routines.dest), 'own_routines');
  assertEquals(revealChoiceFor(undefined), 'plan');
});
