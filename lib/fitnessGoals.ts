import type { CoachGoal } from './types';

export const GOAL_LABELS: Record<CoachGoal, string> = {
  hypertrophy: 'build muscle',
  strength: 'get stronger',
  fat_loss: 'lose fat',
  endurance: 'build endurance',
  general: 'general fitness',
};

/** Old saved intakes have only goal. An explicit empty selection stays empty. */
export function selectedGoals(a: { goals?: unknown; goal?: unknown }): CoachGoal[] {
  const values = Array.isArray(a.goals) ? a.goals : a.goal ? [a.goal] : [];
  return [...new Set(values.filter((v): v is CoachGoal =>
    typeof v === 'string' && Object.hasOwn(GOAL_LABELS, v),
  ))];
}

/** Keep the legacy scalar for program schemas and existing coach consumers. */
export function primaryGoal(a: { goals?: unknown; goal?: unknown }): CoachGoal {
  return selectedGoals(a)[0] ?? 'general';
}

export function toggleGoal(a: { goals?: unknown; goal?: unknown }, value: CoachGoal) {
  const current = selectedGoals(a);
  const goals = current.includes(value)
    ? current.filter((g) => g !== value)
    : [...current, value];
  return { goals, goal: goals[0] ?? null };
}

export function goalLabels(a: { goals?: unknown; goal?: unknown }): string {
  return selectedGoals(a).map((g) => GOAL_LABELS[g]).join(', ');
}
