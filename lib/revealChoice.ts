/**
 * The two buttons under the onboarding plan reveal.
 *
 * "Save my plan" opens phase 1's build on the Goal screen. "I'll build my own
 * routines" lands on Routines instead. Both keep the plan Drona just made:
 * the link only changes where the user lands. Before this, the link threw the
 * plan away, and the people who tapped it (new lifters, mostly) were left with
 * no plan, no routines and an empty Today.
 */
export type RevealChoice = 'plan' | 'own_routines';

export interface RevealFinish {
  /** Save the goal program (Goal & Plan) under the account. */
  createPlan: boolean;
  dest: '/(app)' | '/(app)/routines';
}

export const REVEAL_CHOICES: Record<RevealChoice, RevealFinish> = {
  plan: { createPlan: true, dest: '/(app)' },
  own_routines: { createPlan: true, dest: '/(app)/routines' },
};

/** Which reveal button led to this landing. The analytics value: with both
 *  choices saving the plan, created_plan no longer tells them apart. */
export function revealChoiceFor(dest: RevealFinish['dest'] | undefined): RevealChoice {
  return dest === '/(app)/routines' ? 'own_routines' : 'plan';
}
