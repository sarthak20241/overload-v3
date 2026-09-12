/**
 * The words on a deterministic starter program: its title and its objective.
 *
 * Pulled out of lib/onboardingProgram so it can be unit-tested on its own.
 * The builder there depends on React Native and Supabase modules, so the one
 * part of it a user actually READS had no test around it, and a null date
 * leaked the literal word "null" into a program objective that then persisted
 * to coach_programs.objective. Pure here: no imports, no dates, no I/O.
 */

/** Present only when a pace was chosen AND it projects a real date. */
export interface NarrativeInput {
  /** null when the user is holding steady. */
  direction: 'loss' | 'gain' | null;
  /** Whole weeks the program runs. */
  weeks: number;
  /** Absolute weight change, already formatted and unit-less, e.g. "5.5". */
  diffLabel: string;
  /** Target bodyweight in kg, when there is one. */
  goalWeightKg?: number | null;
  /**
   * Human date the goal lands on, e.g. "Nov 8". NULL whenever no pace has
   * been chosen yet: the onboarding screen seeds the weekly rate in an effect
   * that runs one render AFTER the direction flips, so there is a real window
   * where a direction exists and a date does not.
   */
  dateLabel?: string | null;
  /** Training-goal key; anything unknown falls back to the general wording. */
  goal?: string | null;
  /** Sessions a week, for the steady-state objective. */
  frequency: number;
}

const STEADY_TITLE: Record<string, string> = {
  hypertrophy: '12-Week Muscle Block',
  strength: '12-Week Strength Block',
  fat_loss: '12-Week Lean Block',
  endurance: '12-Week Engine Block',
  general: '12-Week Foundation',
};

/** Title + objective for a starter program. Never interpolates a null. */
export function programNarrative(input: NarrativeInput): { title: string; objective: string } {
  const { direction, weeks, diffLabel, goalWeightKg, frequency } = input;
  const dateLabel = input.dateLabel ?? null;
  const goal = input.goal ?? 'general';

  if (direction === 'loss') {
    return {
      title: `${weeks}-Week Cut to ${goalWeightKg} kg`,
      // Without a pace there is no honest date, so the clause is dropped
      // rather than filled with a placeholder.
      objective: dateLabel
        ? `Down ${diffLabel} kg by ${dateLabel} while your lifts keep climbing.`
        : `Down ${diffLabel} kg while your lifts keep climbing.`,
    };
  }

  if (direction === 'gain') {
    return {
      title: `${weeks}-Week Lean Gain to ${goalWeightKg} kg`,
      objective: dateLabel
        ? `Up ${diffLabel} kg by ${dateLabel}, most of it muscle.`
        : `Up ${diffLabel} kg, most of it muscle.`,
    };
  }

  return {
    title: STEADY_TITLE[goal] ?? STEADY_TITLE.general,
    objective: `Twelve weeks of steady progressive overload, ${frequency} days a week.`,
  };
}
