/**
 * Fuel days in the coach's view of the user.
 *
 * user_context.program comes from get_user_coach_context(), which lists each
 * phase by name, weeks and calories but not its fuel days. Without them,
 * "Adjust with Drona" rebuilt every phase guessing the fuel days it could not
 * see, and moved a user's Saturday out of the phase they were in. This fills
 * them in on the TS side, so the heavy shared RPC stays as it is.
 *
 * Named days, never 0..6: the model should not have to decode a weekday.
 */
import { DAY_NAMES, type FuelDay, normalizeFuelDays } from "../_shared/fuelDays.ts";

export interface PromptFuelDay {
  day: string;
  extra_kcal: number;
  label?: string;
}

/** Fuel days as the model reads them: { day: "Sunday", extra_kcal: 300, label }. */
export function fuelForPrompt(days: FuelDay[]): PromptFuelDay[] {
  return days.map((d) => ({
    day: DAY_NAMES[d.dow],
    extra_kcal: d.kcal,
    ...(d.label ? { label: d.label } : {}),
  }));
}

/**
 * Put each phase's planned fuel days on user_context.program: on every entry
 * of `phases` and on `current_phase`, matched by seq. A phase whose column is
 * null said nothing about fuel days and gets no key; an empty list is an
 * answer ("none") and is kept as []. Returns the program unchanged when it is
 * not the expected shape.
 */
export function withPhaseFuelDays(
  program: unknown,
  rows: { seq: number; diet_fuel_days: unknown }[],
): unknown {
  if (!program || typeof program !== "object") return program;
  const bySeq = new Map<number, PromptFuelDay[]>();
  for (const r of rows) {
    if (typeof r.seq !== "number" || r.diet_fuel_days == null) continue;
    bySeq.set(r.seq, fuelForPrompt(normalizeFuelDays(r.diet_fuel_days)));
  }
  if (bySeq.size === 0) return program;
  const p = program as Record<string, unknown>;
  const withFuel = (ph: unknown) => {
    if (!ph || typeof ph !== "object") return ph;
    const seq = (ph as { seq?: unknown }).seq;
    return typeof seq === "number" && bySeq.has(seq) ? { ...ph, fuel_days: bySeq.get(seq) } : ph;
  };
  return {
    ...p,
    ...(Array.isArray(p.phases) ? { phases: p.phases.map(withFuel) } : {}),
    ...(p.current_phase ? { current_phase: withFuel(p.current_phase) } : {}),
  };
}
