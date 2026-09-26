/**
 * B1: logging well, weight not moving, lower calories
 * (.planning/drona-cards-scenarios.md, section B1).
 *
 * The first card the MODEL decides. This module is everything AROUND the model:
 *   gate       the rules that must all pass before the model is even asked
 *   anchor     the rules-only answer (10% or 150 kcal, whichever is less), the
 *              number the model is shown as a reference
 *   floor      Mifflin-St Jeor resting energy when the body is known; a fixed
 *              floor when it is not. No card may go under it.
 *   validator  the last word on what the model said: a real cut, at most 10%,
 *              above the floor, a rationale with no promise the code cannot keep
 *   card       the act card, with the numbers the user can check and the four
 *              targets Undo will need
 *
 * Pure: no imports beyond a type and the pure fuel-day rules, no Date.
 * Unit-tested in dronaCalories.test.ts.
 */
import type { DronaFacts } from './dronaCards.ts';
import { dowOfISO, type FuelDay, kcalOnDow, normalizeFuelDays } from './fuelDays.ts';

export interface DietBody {
  gender?: 'M' | 'F' | 'O' | string | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  age_years?: number | null;
}

export interface DietTargets {
  kcal?: number | null;
  protein_g?: number | null;
  carb_g?: number | null;
  fat_g?: number | null;
}

export interface DietFacts {
  as_of?: string;
  tier?: string | null;
  tier_expires_at?: string | null;
  body?: DietBody;
  targets?: DietTargets;
  phase?: (DietTargets & { id?: string | null }) | null;
  /** Newest first. Whole days only: today is not over, so it is never here (see completeFood). */
  food?: { day: string; kcal: number; protein_g?: number }[];
  /** Newest first. */
  weight?: { day: string; kg: number }[];
  /** Newest first: what the calorie target was moved from and to, by whom. */
  target_changes?: { at: string; from: number | null; to: number | null; source: string; card_id?: string | null }[];
  days_since_target_change?: number | null;
  /** Weekdays with extra calories on top of targets.kcal (see fuelDays.ts). */
  fuel_days?: FuelDay[] | null;
}

const PRO_TIERS = new Set(['monthly', 'annual', 'founding_lifetime', 'appsumo_lifetime']);
const CUT_GOALS = new Set(['fat_loss', 'weight_loss', 'lose_weight', 'cut']);

const FOOD_DAYS_MIN = 9;          // of 14
const ON_TARGET_SHARE_MIN = 0.7;  // of the logged days
const WEIGH_INS_MIN = 6;          // in 14 days
const FLAT_SLOPE_KG_PER_WEEK = -0.15; // above this the scale is not moving
const SETTLE_DAYS = 14;           // after a calorie change, leave it be
export const MAX_STEP_SHARE = 0.10;
const MAX_STEP_KCAL = 150;
const GRID = 25;

const n = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** A paid tier that has not run out on the day in question. */
export function isProTier(tier: string | null | undefined, expiresAt: string | null | undefined, asOf: string): boolean {
  if (!tier || !PRO_TIERS.has(tier)) return false;
  if (!expiresAt) return true;
  const exp = Date.parse(expiresAt);
  const day = Date.parse(`${asOf}T23:59:59Z`);
  return !Number.isFinite(exp) || !Number.isFinite(day) || exp > day;
}

/**
 * The safety floor. Resting energy by Mifflin-St Jeor when weight, height and
 * age are all known; otherwise a fixed floor by sex, and the widest of the
 * three when even that is unknown. Never below the diet bounds' 800.
 */
export function floorKcalFor(body: DietBody | null | undefined): number {
  const w = n(body?.weight_kg);
  const h = n(body?.height_cm);
  const a = n(body?.age_years);
  const g = body?.gender;
  if (w != null && h != null && a != null && (g === 'M' || g === 'F')) {
    const bmr = 10 * w + 6.25 * h - 5 * a + (g === 'M' ? 5 : -161);
    return Math.max(800, Math.round(bmr));
  }
  if (g === 'F') return 1200;
  if (g === 'M') return 1500;
  return 1350;
}

/** Least-squares slope of kg against days, in kg per week. Null under 2 points. */
export function slopeKgPerWeek(series: { day: string; kg: number }[] | undefined): number | null {
  const pts = (series ?? [])
    .map((p) => ({ x: Date.parse(`${p.day}T00:00:00Z`) / 86_400_000, y: n(p.kg) }))
    .filter((p): p is { x: number; y: number } => Number.isFinite(p.x) && p.y != null);
  if (pts.length < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den === 0) return null;
  return Math.round((num / den) * 7 * 100) / 100;
}

/** The rules-only answer: 10% or 150 kcal off, whichever is less, on a 25 grid. */
export function anchorKcal(from: number): number {
  const step = Math.min(Math.round(from * MAX_STEP_SHARE), MAX_STEP_KCAL);
  return Math.round((from - step) / GRID) * GRID;
}

export interface CalorieGate {
  eligible: boolean;
  /** Every reason the gate did not open. Empty when eligible. */
  reasons: string[];
  anchor: { from: number; to: number; floor: number; slope_14d: number | null } | null;
}

/**
 * All of these must hold before the model is asked. Any one missing is a
 * hold, and the reason is kept so the week's audit says why.
 */
export function calorieGate(facts: DronaFacts, diet: DietFacts): CalorieGate {
  const reasons: string[] = [];
  const asOf = facts.as_of ?? diet.as_of ?? '';

  if (!isProTier(diet.tier ?? facts.tier, diet.tier_expires_at, asOf)) reasons.push('not_pro');

  const goal = (facts.goal?.program_goal ?? facts.goal?.goal ?? '').toLowerCase();
  if (!CUT_GOALS.has(goal)) reasons.push('not_a_cut');

  const from = n(diet.targets?.kcal) ?? n(facts.nutrition?.target_kcal);
  if (from == null) reasons.push('no_target');

  const foodDays = n(facts.nutrition?.days_logged_14d) ?? 0;
  const onTarget = n(facts.nutrition?.on_target_days_14d) ?? 0;
  if (foodDays < FOOD_DAYS_MIN) reasons.push('food_thin');
  else if (onTarget < foodDays * ON_TARGET_SHARE_MIN) reasons.push('off_target');

  const weighIns = n(facts.weight?.weigh_ins_14d) ?? 0;
  const slope = slopeKgPerWeek(diet.weight?.filter((p) => p.day > dayBefore(asOf, 14)));
  if (weighIns < WEIGH_INS_MIN || slope == null) reasons.push('weight_thin');
  else if (slope <= FLAT_SLOPE_KG_PER_WEEK) reasons.push('losing');

  const since = n(diet.days_since_target_change);
  if (since != null && since < SETTLE_DAYS) reasons.push('just_changed');

  let anchor: CalorieGate['anchor'] = null;
  if (from != null) {
    const floor = floorKcalFor(diet.body);
    const to = anchorKcal(from);
    if (to < floor || to >= from) reasons.push('at_floor');
    anchor = { from, to, floor, slope_14d: slope };
  }

  return { eligible: reasons.length === 0, reasons, anchor };
}

function dayBefore(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - days * 86_400_000).toISOString().slice(0, 10) : '';
}

/**
 * Food on the whole days in the `days` before `asOf`, newest first. Today is
 * left out: it is not over, and the app path asks at any hour, so today is
 * usually half logged and reads as a crash diet. That also makes the app see
 * the same days the Monday cron does. The facts functions end the window at
 * yesterday too (0135); this holds even when a caller's rows do not.
 */
export function completeFood(diet: DietFacts, asOf: string, days: number): NonNullable<DietFacts['food']> {
  const from = dayBefore(asOf, days);
  return (diet.food ?? []).filter((r) => r.day >= from && r.day < asOf);
}

/**
 * The ugliness a good mean hides. Four reads of the raw series, each a general
 * coaching rule, each computed here so the validator does not have to trust
 * the model to have looked:
 *   blowout_day   one day far above target makes the average a lie
 *   noisy_scale   readings swinging over a kilo cannot show a trend
 *   protein_low   fixing protein comes before cutting calories
 *   raised_back   the user raised the target back by hand after a cut: they
 *                 have answered, and a card would argue with them
 */
export const BLOWOUT_SHARE = 1.35;      // a day over 135% of target
export const NOISE_RANGE_KG = 1.2;      // max minus min over the 14-day window
export const PROTEIN_SHARE_MIN = 0.8;   // mean protein under 80% of target
const RAISED_BACK_DAYS = 60;

export interface UglyChecks {
  worst_day_kcal: number | null;
  weight_range_kg: number | null;
  mean_protein_g: number | null;
  raised_back: boolean;
  failed: string[];
}

export function uglyChecks(facts: DronaFacts, diet: DietFacts): UglyChecks {
  const asOf = facts.as_of ?? diet.as_of ?? '';
  const target = n(diet.targets?.kcal) ?? n(facts.nutrition?.target_kcal);
  const proteinTarget = n(diet.targets?.protein_g);
  const failed: string[] = [];

  const food14 = completeFood(diet, asOf, 14);
  const worst = food14.length ? Math.max(...food14.map((r) => n(r.kcal) ?? 0)) : null;
  // Each day against its OWN target: a 2,600 kcal long-run Sunday on a 2,000
  // base with +300 fuel is a day eaten to plan, not a blowout.
  const fuel = normalizeFuelDays(diet.fuel_days);
  const blowout = target != null && food14.some((r) =>
    (n(r.kcal) ?? 0) > kcalOnDow(target, fuel, dowOfISO(r.day)) * BLOWOUT_SHARE);
  if (blowout) failed.push('blowout_day');

  const w14 = (diet.weight ?? []).filter((p) => p.day > dayBefore(asOf, 14)).map((p) => n(p.kg)).filter((v): v is number => v != null);
  const range = w14.length >= 2 ? Math.round((Math.max(...w14) - Math.min(...w14)) * 10) / 10 : null;
  if (range != null && range > NOISE_RANGE_KG) failed.push('noisy_scale');

  const prot = food14.map((r) => n(r.protein_g)).filter((v): v is number => v != null);
  const meanProtein = prot.length ? Math.round(prot.reduce((a, b) => a + b, 0) / prot.length) : null;
  if (meanProtein != null && proteinTarget != null && meanProtein < proteinTarget * PROTEIN_SHARE_MIN) failed.push('protein_low');

  // A manual raise that undid a cut made by a card or a chat, in the last 60 days.
  const changes = diet.target_changes ?? [];
  const since = Date.parse(`${asOf}T00:00:00Z`) - RAISED_BACK_DAYS * 86_400_000;
  const raisedBack = changes.some((c, i) => {
    if (c.source !== 'manual' || (c.to ?? 0) <= (c.from ?? 0)) return false;
    if (Number.isFinite(since) && Date.parse(c.at) < since) return false;
    const earlier = changes.slice(i + 1).find((e) => e.source !== 'manual' && (e.to ?? 0) < (e.from ?? 0));
    return !!earlier;
  });
  if (raisedBack) failed.push('raised_back');

  return { worst_day_kcal: worst, weight_range_kg: range, mean_protein_g: meanProtein, raised_back: raisedBack, failed };
}

/** Words that promise something this pipeline does not do. */
const FALSE_PROMISES = [/\bi will (check|re-?check|look|come back|follow up)\b/i, /\bcheck back\b/i, /\bnext week i\b/i, /—/];

/**
 * The last word on what the model proposed. A miss is a hold, never a retry.
 */
export function validateTargets(
  input: { calories?: unknown; rationale?: unknown; worst_day_kcal?: unknown; weight_range_kg?: unknown },
  ctx: { from: number; floor: number; checks?: UglyChecks },
): { ok: true; kcal: number; rationale: string } | { ok: false; reason: string } {
  // An ugly week is refused before the number is even read.
  if (ctx.checks?.failed.length) return { ok: false, reason: ctx.checks.failed[0] };
  // The model must have read the series: its worst day and weight range have
  // to match what the data says, within rounding.
  if (ctx.checks) {
    const worst = typeof input.worst_day_kcal === 'number' ? input.worst_day_kcal : NaN;
    const range = typeof input.weight_range_kg === 'number' ? input.weight_range_kg : NaN;
    if (ctx.checks.worst_day_kcal != null && !(Math.abs(worst - ctx.checks.worst_day_kcal) <= 60)) return { ok: false, reason: 'worst_day_mismatch' };
    if (ctx.checks.weight_range_kg != null && !(Math.abs(range - ctx.checks.weight_range_kg) <= 0.25)) return { ok: false, reason: 'weight_range_mismatch' };
  }
  const kcal = typeof input.calories === 'number' ? input.calories : NaN;
  if (!Number.isInteger(kcal)) return { ok: false, reason: 'calories_not_integer' };
  if (kcal >= ctx.from) return { ok: false, reason: 'not_a_cut' };
  if (kcal < Math.round(ctx.from * (1 - MAX_STEP_SHARE))) return { ok: false, reason: 'step_over_10pct' };
  if (kcal < ctx.floor) return { ok: false, reason: 'under_floor' };
  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
  if (rationale.length < 20 || rationale.length > 320) return { ok: false, reason: 'rationale_length' };
  if (FALSE_PROMISES.some((re) => re.test(rationale))) return { ok: false, reason: 'rationale_promise' };
  return { ok: true, kcal, rationale };
}

export interface CaloriesCard {
  kind: 'act';
  topic: 'calories';
  title: string;
  body: string;
  evidence: { label: string; value: string }[];
  payload: {
    action: 'apply_targets';
    from_kcal: number;
    to_kcal: number;
    from_protein_g: number | null;
    from_carb_g: number | null;
    from_fat_g: number | null;
    phase_id: string | null;
  };
  signals: string[];
}

/** The act card. Body is the model's own sentence; the numbers are the facts'. */
export function caloriesCard(facts: DronaFacts, diet: DietFacts, toKcal: number, rationale: string): CaloriesCard {
  const from = n(diet.targets?.kcal) ?? n(facts.nutrition?.target_kcal) ?? 0;
  const foodDays = n(facts.nutrition?.days_logged_14d) ?? 0;
  const onTarget = n(facts.nutrition?.on_target_days_14d) ?? 0;
  const series = diet.weight ?? [];
  const newest = series[0]?.kg;
  const oldest = series[series.length - 1]?.kg;
  const change = newest != null && oldest != null ? Math.round((newest - oldest) * 10) / 10 : 0;
  const changeText = `${change > 0 ? '+' : ''}${change.toFixed(1)} kg`;

  return {
    kind: 'act',
    topic: 'calories',
    title: `Let us try ${toKcal} kcal`,
    body: rationale,
    evidence: [
      { label: 'Days logged in 14', value: String(foodDays) },
      { label: 'Days near target', value: String(onTarget) },
      { label: 'Current target', value: String(from) },
      { label: 'Weight change', value: changeText },
    ],
    payload: {
      action: 'apply_targets',
      from_kcal: from,
      to_kcal: toKcal,
      from_protein_g: n(diet.targets?.protein_g),
      from_carb_g: n(diet.targets?.carb_g),
      from_fat_g: n(diet.targets?.fat_g),
      phase_id: diet.phase?.id ?? null,
    },
    signals: ['cut', 'food_good', 'weight_flat', 'settled'],
  };
}
