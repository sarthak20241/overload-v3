// The rules a program follows when ChatGPT or Claude writes one: the same
// rules Drona's programs follow in the app. No I/O here, so the tests reach
// every rule directly.
//
//   programGoalFor     copy of lib/fitnessGoals.ts (a cut is fat_loss). The
//                      edge function cannot import lib/ (it would not deploy),
//                      so programRules.test.ts pins this copy to the app's.
//   fillMissingMacros  copy of lib/dietData.ts: the macros left out share the
//                      calories the given ones leave, so all four add up.
//   DIET_BOUNDS        lib/programData.ts: the daily ranges a target may take.
//
// The phase shapes (fuel days, activity goals, metrics, week pattern) use the
// _shared normalizers the app and the coach already share.

import { clampCardioSessions, clampStepsTarget, normalizeActivityGoals } from "../_shared/activityGoals.ts";
import { type FuelDay, fuelDaysFromCoach } from "../_shared/fuelDays.ts";
import { normalizeMetrics, type PhaseMetricInput } from "../_shared/phaseMetrics.ts";
import { normalizeWeekPattern } from "../_shared/weekPattern.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const GOALS = ["hypertrophy", "strength", "fat_loss", "endurance", "general"] as const;
export type Goal = typeof GOALS[number];

/** lib/fitnessGoals.ts programGoalFor: what the PROGRAM does. A target 1 kg
 *  or more below today's weight is a cut whatever the label; a gain is never
 *  fat_loss. */
export function programGoalFor(goal: unknown, targetWeightKg: number | null | undefined, currentWeightKg: number | null | undefined): Goal {
  const given: Goal = typeof goal === "string" && (GOALS as readonly string[]).includes(goal) ? goal as Goal : "general";
  if (targetWeightKg == null || currentWeightKg == null || !(currentWeightKg > 0)) return given;
  const diff = targetWeightKg - currentWeightKg;
  if (diff <= -1) return "fat_loss";
  if (diff >= 1 && given === "fat_loss") return "hypertrophy";
  return given;
}

export const KCAL_PER_G = { protein: 4, carb: 4, fat: 9 } as const;
export const DEFAULT_TARGETS = { kcal: 2000, protein: 125, carb: 250, fat: 56 };
export const DIET_BOUNDS = {
  calories: [800, 6000],
  protein_g: [20, 400],
  carb_g: [0, 1000],
  fat_g: [0, 400],
} as const;

type Macros = { protein: number; carb: number; fat: number };

/** lib/dietData.ts fillMissingMacros. */
export function fillMissingMacros(
  kcal: number,
  given: { protein?: number | null; carb?: number | null; fat?: number | null },
  current: Macros,
): Macros {
  const KEYS = ["protein", "carb", "fat"] as const;
  const out = { protein: given.protein ?? current.protein, carb: given.carb ?? current.carb, fat: given.fat ?? current.fat };
  const missing = KEYS.filter((k) => given[k] == null);
  if (missing.length === 0) return out;
  const fixedKcal = KEYS.filter((k) => given[k] != null).reduce((s, k) => s + (given[k] as number) * KCAL_PER_G[k], 0);
  const remaining = Math.max(0, kcal - fixedKcal);
  const raw = missing.map((k) => current[k] * KCAL_PER_G[k]);
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  const weights = rawTotal > 0 ? raw : missing.map((k) => DEFAULT_TARGETS[k] * KCAL_PER_G[k]);
  const wTotal = weights.reduce((a, b) => a + b, 0);
  const share = wTotal > 0 ? weights.map((w) => w / wTotal) : missing.map(() => 1 / missing.length);
  let used = 0;
  missing.forEach((k, i) => {
    if (i < missing.length - 1) {
      const grams = Math.max(0, Math.round((remaining * share[i]) / KCAL_PER_G[k]));
      out[k] = grams;
      used += grams * KCAL_PER_G[k];
    } else {
      out[k] = Math.max(0, Math.round((remaining - used) / KCAL_PER_G[k]));
    }
  });
  return out;
}

export const macroKcal = (m: Macros) => m.protein * 4 + m.carb * 4 + m.fat * 9;

/** How far four given targets may miss each other: 5%, at least 50 kcal. */
export const ADD_UP_SLACK = (kcal: number) => Math.max(50, Math.round(kcal * 0.05));

export interface Diet { kcal: number; protein: number; carb: number; fat: number }

const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * A phase's four daily targets, adding up. `given` is what the assistant
 * sent; `base` the targets to keep for anything it left out (the phase's own
 * when editing, the user's live targets when creating). Calories and protein
 * fall back to base; carbs and fat left out are worked out from the calories.
 */
export function dietFor(given: Row | null | undefined, base: Diet): Diet | string {
  const g = given ?? {};
  const kcal = int(g.calories) ?? base.kcal;
  const protein = int(g.protein_g);
  const carb = int(g.carb_g);
  const fat = int(g.fat_g);
  const keepProtein = protein ?? base.protein;
  const filled = fillMissingMacros(kcal, { protein: keepProtein, carb, fat }, base);
  const d: Diet = { kcal, ...filled };
  for (const [k, v] of [["calories", d.kcal], ["protein_g", d.protein], ["carb_g", d.carb], ["fat_g", d.fat]] as const) {
    const [lo, hi] = DIET_BOUNDS[k];
    if (v < lo || v > hi) return `${k} ${v} is outside ${lo}-${hi}${k === "carb_g" || k === "fat_g" ? " (protein and the others leave no room for it)" : ""}.`;
  }
  if (carb != null && fat != null) {
    const off = macroKcal(d) - d.kcal;
    if (Math.abs(off) > ADD_UP_SLACK(d.kcal)) {
      return `the macros add up to ${macroKcal(d)} kcal, not ${d.kcal}. Send macros that add up (protein and carbs 4 kcal/g, fat 9 kcal/g), or leave carbs or fat out and Overload works them out.`;
    }
  }
  return d;
}

/** The phase columns a phase input sets, besides the diet. Keys that are
 *  absent stay as they are when editing. */
export interface PhaseRow {
  id?: string;
  name: string;
  duration_weeks: number;
  diet_calorie_target: number;
  diet_protein_g: number;
  diet_carb_g: number;
  diet_fat_g: number;
  diet_directive: string | null;
  training_directive: string | null;
  readiness_directive: string | null;
  training_block: Row | null;
  diet_fuel_days: FuelDay[] | null;
  activity_steps_target: number | null;
  cardio_sessions_per_week: number | null;
  job_text: string | null;
  metrics?: PhaseMetricInput[];
}

const text = (v: unknown, max = 2000): string | null =>
  typeof v === "string" && v.trim() ? v.trim().replace(/—/g, ", ").slice(0, max) : null;

function blockOf(v: unknown): Row | null | string {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "training_block must be an object.";
  const b = v as Row;
  const days = int(b.days_per_week);
  if (days != null && (days < 1 || days > 7)) return "training_block.days_per_week must be 1-7.";
  const out: Row = {};
  if (text(b.split_type, 60)) out.split_type = text(b.split_type, 60);
  if (days != null) out.days_per_week = days;
  if (text(b.emphasis, 200)) out.emphasis = text(b.emphasis, 200);
  if (text(b.note, 200)) out.note = text(b.note, 200);
  const week = normalizeWeekPattern(b.week_pattern, days ?? 0);
  if (b.week_pattern != null && !week) {
    return "training_block.week_pattern must be 7 entries (Day 1 to Day 7, \"Rest\" for a day off) with exactly days_per_week training days.";
  }
  if (week) out.week_pattern = week;
  return Object.keys(out).length ? out : null;
}

/**
 * One phase from the assistant, checked and shaped as the database stores it.
 * `before` is the stored phase when editing: every field the input leaves out
 * keeps its stored value. Returns a message when the input cannot be saved.
 */
export function phaseRow(input: Row, where: string, base: Diet, before?: Row): PhaseRow | string {
  const has = (k: string) => Object.hasOwn(input, k);
  const name = has("name") ? text(input.name, 80) : before?.name ?? null;
  if (!name) return `${where}: a phase needs a name.`;
  const weeks = has("duration_weeks") ? int(input.duration_weeks) : before?.duration_weeks ?? null;
  if (weeks == null || weeks < 1 || weeks > 26) return `${where}: duration_weeks must be 1-26.`;

  const stored: Diet | null = before && before.diet_calorie_target != null
    ? {
      kcal: before.diet_calorie_target,
      protein: before.diet_protein_g ?? base.protein,
      carb: before.diet_carb_g ?? base.carb,
      fat: before.diet_fat_g ?? base.fat,
    }
    : null;
  if (!has("diet") && !stored && !before) return `${where}: a new phase needs diet.calories and diet.protein_g.`;
  if (has("diet") && !before && (input.diet?.calories == null || input.diet?.protein_g == null)) {
    return `${where}: a new phase needs diet.calories and diet.protein_g.`;
  }
  const diet = has("diet") ? dietFor(input.diet, stored ?? base) : stored ?? base;
  if (typeof diet === "string") return `${where}: ${diet}`;

  const block = has("training_block") ? blockOf(input.training_block) : (before?.training_block ?? null);
  if (typeof block === "string") return `${where}: ${block}`;
  if (!before && !block) return `${where}: a new phase needs a training_block (split_type, days_per_week, week_pattern).`;

  let fuel: FuelDay[] | null = before?.diet_fuel_days ?? null;
  if (has("fuel_days")) {
    if (input.fuel_days === null) fuel = [];
    else {
      const f = fuelDaysFromCoach(input.fuel_days);
      if (f === undefined) return `${where}: fuel_days needs entries like {"day": "Sunday", "extra_kcal": 300}. Send [] to remove them.`;
      fuel = f;
    }
  }

  let steps: number | null = before?.activity_steps_target ?? null;
  let cardio: number | null = before?.cardio_sessions_per_week ?? null;
  if (has("activity")) {
    if (input.activity === null) {
      steps = null;
      cardio = null;
    } else {
      const a = input.activity as Row;
      const g = normalizeActivityGoals(a);
      // A key sent as null clears that one goal; a key left out keeps it.
      if (Object.hasOwn(a, "steps_per_day")) steps = a.steps_per_day == null ? null : g.steps_per_day;
      if (Object.hasOwn(a, "cardio_sessions_per_week")) {
        cardio = a.cardio_sessions_per_week == null ? null : g.cardio_sessions_per_week;
      }
    }
  }

  const row: PhaseRow = {
    ...(before?.id ? { id: before.id } : {}),
    name,
    duration_weeks: weeks,
    diet_calorie_target: diet.kcal,
    diet_protein_g: diet.protein,
    diet_carb_g: diet.carb,
    diet_fat_g: diet.fat,
    diet_directive: has("diet_directive") ? text(input.diet_directive) : before?.diet_directive ?? null,
    training_directive: has("training_directive") ? text(input.training_directive) : before?.training_directive ?? null,
    readiness_directive: has("readiness_directive") ? text(input.readiness_directive) : before?.readiness_directive ?? null,
    training_block: block,
    diet_fuel_days: fuel,
    activity_steps_target: clampStepsTarget(steps),
    cardio_sessions_per_week: clampCardioSessions(cardio),
    job_text: has("job_text") ? text(input.job_text, 80) : before?.job_text ?? null,
  };
  if (has("metrics")) {
    if (input.metrics !== null && !Array.isArray(input.metrics)) return `${where}: metrics must be a list.`;
    const m = normalizeMetrics(input.metrics ?? []);
    if (Array.isArray(input.metrics) && input.metrics.length > 0 && m.length === 0) {
      return `${where}: no metric could be read. Each needs a kind and a target (lift_e1rm also an exercise).`;
    }
    row.metrics = m;
  }
  return row;
}

/** Cumulative start offsets in weeks, phase 0 = 0. */
export function offsetsOf(phases: { duration_weeks: number }[]): number[] {
  let acc = 0;
  return phases.map((p) => {
    const at = acc;
    acc += p.duration_weeks;
    return at;
  });
}

/** Did a phase's live-target fields change between two versions? */
export function targetsChanged(a: Row | undefined, b: PhaseRow): boolean {
  if (!a) return true;
  const fuel = (v: unknown) => JSON.stringify(v ?? null);
  return a.diet_calorie_target !== b.diet_calorie_target || a.diet_protein_g !== b.diet_protein_g ||
    a.diet_carb_g !== b.diet_carb_g || a.diet_fat_g !== b.diet_fat_g || fuel(a.diet_fuel_days) !== fuel(b.diet_fuel_days);
}

/** What the live profile gets for a running phase (lib/programData.ts
 *  applyPhaseTargets). fuel_days only when the phase planned some. */
export function mirrorOf(seq: number, p: PhaseRow): Row {
  return {
    seq,
    kcal: p.diet_calorie_target,
    protein_g: p.diet_protein_g,
    carb_g: p.diet_carb_g,
    fat_g: p.diet_fat_g,
    ...(p.diet_fuel_days != null ? { fuel_days: p.diet_fuel_days } : {}),
  };
}
