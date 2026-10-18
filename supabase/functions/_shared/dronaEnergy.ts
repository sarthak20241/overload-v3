/**
 * The adaptive calories cards, read from last week's behaviours
 * (get_drona_energy_facts, migration 20261017115750_drona_energy_facts).
 *
 * The database does the measuring: a maintenance estimate that starts at the
 * app's own formula and moves toward the person's real number as weigh-ins
 * and whole food days arrive. This module only turns two behaviours into a
 * card the app already knows how to show:
 *
 *   calories_off         an act card, "Set X kcal", with Undo. Pro only, like
 *                        B1. The step is at most 200 kcal, never under the
 *                        resting-energy floor, and only when the live target
 *                        is 100+ kcal from what the goal needs.
 *   finding_maintenance  a request: weigh in (the estimate needs weigh-ins, or
 *                        the trend has gone stale), else log whole days.
 *
 * A calorie card comes first when there is one: it can only exist when the
 * data is already fresh enough. A topic on cooldown, or muted because its
 * cards stopped landing (topic_not_landing), is skipped.
 *
 * The calorie check-in (2026-10-18) is its own slot, apart from the weekly
 * Drona card, with its own cooldown (checkinCooldown): a calorie change can
 * come every week while the estimate is learning, a data ask at most every two
 * weeks. A calorie change also moves the program's future phases by what the
 * estimate learned since they were set (phaseMoves), on the same tap.
 *
 * Pure: no imports beyond the tier rule, no Date. Unit-tested in dronaEnergy.test.ts.
 */
import { isProTier } from './dronaCalories.ts';

export interface EnergyBehaviour {
  behaviour: string;
  card_kind: string;
  priority: number;
  mutes?: string[] | null;
  detail?: Record<string, unknown> | null;
}

export interface EnergyFacts {
  as_of?: string;
  week_start?: string;
  tier?: string | null;
  tier_expires_at?: string | null;
  targets?: { kcal?: number | null; protein_g?: number | null; carb_g?: number | null; fat_g?: number | null } | null;
  phase_id?: string | null;
  /** Last week's maintenance estimate and resting-energy floor. */
  estimate_kcal?: number | null;
  floor_kcal?: number | null;
  /** The running program: the maintenance its phases assume, and the phases still to come. */
  program?: { id?: string; basis_kcal?: number | null; phases?: FuturePhase[] | null } | null;
  /** Recent cards of every slot, newest first. */
  cards?: { week_start?: string; slot?: string; topic?: string; kind?: string; status?: string }[] | null;
  behaviours?: EnergyBehaviour[] | null;
}

export interface FuturePhase {
  id: string;
  seq?: number;
  name?: string | null;
  starts_on?: string;
  kcal?: number | null;
  protein_g?: number | null;
  carb_g?: number | null;
  fat_g?: number | null;
}

export interface PhaseMove {
  id: string;
  name: string;
  from_kcal: number;
  to_kcal: number;
  from_protein_g: number | null;
  from_carb_g: number | null;
  from_fat_g: number | null;
}

export interface EnergyCard {
  kind: 'act' | 'request';
  topic: 'calories' | 'weigh_in' | 'log_food';
  title: string;
  body: string;
  evidence: { label: string; value: string }[];
  payload: Record<string, unknown>;
  signals: string[];
}

export const MIN_CHANGE_KCAL = 100;
export const MAX_STEP_KCAL = 200;
const GRID = 25;
const WEIGH_INS_FOR_A_READ = 8;
const WHOLE_DAYS_FOR_A_READ = 14;

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The calorie target a calories_off week leads to, or null when no change is
 * due. Moves at most MAX_STEP_KCAL toward the suggestion, on a 25 grid, and
 * never under the floor rounded up to the grid.
 */
export function nextTarget(live: number | null, suggested: number | null, floor: number | null): number | null {
  if (live == null || suggested == null) return null;
  const gap = suggested - live;
  if (Math.abs(gap) < MIN_CHANGE_KCAL) return null;
  const step = Math.max(-MAX_STEP_KCAL, Math.min(MAX_STEP_KCAL, gap));
  let to = Math.round((live + step) / GRID) * GRID;
  if (floor != null) to = Math.max(to, Math.ceil(floor / GRID) * GRID);
  return to === live ? null : to;
}

/**
 * How the program's future phases move with the estimate. Each keeps its
 * purpose (a cut stays a cut, a diet break stays at maintenance); only the base
 * moves, by what the estimate learned since the phases were set. Never under
 * the floor. Null when nothing moves by 25 kcal or more.
 */
export function phaseMoves(f: EnergyFacts, estimate: number | null, floor: number | null):
  { moves: PhaseMove[]; basis_from: number; basis_to: number } | null {
  const basis = n(f.program?.basis_kcal);
  if (estimate == null || basis == null) return null;
  const delta = Math.round((estimate - basis) / GRID) * GRID;
  if (Math.abs(delta) < GRID) return null;
  const floorGrid = floor != null ? Math.ceil(floor / GRID) * GRID : null;
  const moves: PhaseMove[] = [];
  for (const ph of f.program?.phases ?? []) {
    const kcal = n(ph.kcal);
    if (!ph.id || kcal == null) continue;
    let to = Math.round((kcal + delta) / GRID) * GRID;
    if (floorGrid != null) to = Math.max(to, floorGrid);
    if (to === kcal) continue;
    moves.push({
      id: ph.id, name: ph.name?.trim() || `Phase ${ph.seq ?? ''}`.trim(), from_kcal: kcal, to_kcal: to,
      from_protein_g: n(ph.protein_g), from_carb_g: n(ph.carb_g), from_fat_g: n(ph.fat_g),
    });
  }
  return moves.length ? { moves, basis_from: basis, basis_to: Math.round(estimate) } : null;
}

const MS_WEEK = 7 * 86_400_000;
function weeksBetween(from: string | undefined, to: string | undefined): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / MS_WEEK) : null;
}

/**
 * The check-in's own cooldown, from recent cards of every slot. A calorie
 * change may come every week (the behaviour already decides how often), but
 * not twice in a week, and not within two weeks of a "keep the plan". A data
 * ask waits two weeks after the same ask, four after a "no thanks".
 */
export function checkinCooldown(cards: EnergyFacts['cards'], weekStart: string): (topic: string) => boolean {
  return (topic: string) => (cards ?? []).some((c) => {
    if (c.topic !== topic) return false;
    const weeks = weeksBetween(c.week_start, weekStart);
    if (weeks == null || weeks < 0) return false;
    if (topic === 'calories') return weeks < 1 || (c.status === 'dismissed' && weeks < 2);
    return weeks < (c.status === 'dismissed' ? 4 : 2);
  });
}

function caloriesCard(f: EnergyFacts, d: Record<string, unknown>, live: number, to: number): EnergyCard {
  const est = n(d.estimate_kcal);
  const suggested = n(d.suggested_kcal);
  const goal = n(d.goal_kg);
  const pace = n(d.pace_kg_per_week);
  const rate = n(d.trend_rate_kg_per_week);
  const readings = n(d.readings) ?? 0;
  const whole = n(d.whole_days) ?? 0;

  const parts = [`You burn about ${est} kcal a day, read from ${readings} weigh-ins and ${whole} whole days of food.`];
  if (suggested != null && goal != null && pace != null) {
    parts.push(`About ${suggested} kcal would move you toward ${goal} kg at ${Math.abs(pace).toFixed(2)} kg a week.`);
  }
  if (suggested != null && to !== suggested) parts.push(`${to} is a careful first step.`);
  const phases = phaseMoves(f, n(f.estimate_kcal) ?? est, n(d.floor_kcal));
  if (phases) {
    const named = phases.moves.slice(0, 2).map((m) => `${m.name} ${m.from_kcal} to ${m.to_kcal}`).join(', ');
    const more = phases.moves.length > 2 ? ` and ${phases.moves.length - 2} more` : '';
    parts.push(`Your next ${phases.moves.length === 1 ? 'phase moves' : 'phases move'} with it: ${named}${more}.`);
  }

  return {
    kind: 'act',
    topic: 'calories',
    title: `Let us try ${to} kcal`,
    body: parts.join(' '),
    evidence: [
      { label: 'Your maintenance', value: String(est ?? '') },
      { label: 'Current target', value: String(live) },
      { label: 'Weight trend', value: rate == null ? 'n/a' : `${rate > 0 ? '+' : ''}${rate.toFixed(2)} kg/wk` },
    ],
    payload: {
      action: 'apply_targets',
      from_kcal: live,
      to_kcal: to,
      from_protein_g: n(f.targets?.protein_g),
      from_carb_g: n(f.targets?.carb_g),
      from_fat_g: n(f.targets?.fat_g),
      phase_id: f.phase_id ?? null,
      ...(phases ? {
        program_id: f.program?.id ?? null,
        basis_from_kcal: phases.basis_from,
        basis_to_kcal: phases.basis_to,
        phases: phases.moves,
      } : {}),
    },
    signals: ['calories_off', String(d.source ?? '')].filter(Boolean),
  };
}

function weighInCard(d: Record<string, unknown>, missing: string[]): EnergyCard {
  const readings = n(d.readings) ?? 0;
  const source = String(d.source ?? '');
  const body = missing.includes('scale')
    ? 'A few recent weigh-ins jumped far from the rest. Same scale, same time, right after waking, and the trend gets honest.'
    : source === 'learning' || source === 'measured'
      ? 'I am working out what your body really burns from your weigh-ins and your food. Three mornings this week keeps that number honest.'
      : 'Your calories come from a formula right now. A few mornings on the scale, with your food logs, and I can work out what your body really burns.';
  return {
    kind: 'request',
    topic: 'weigh_in',
    title: missing.includes('weigh_ins') ? 'Three mornings on the scale' : 'Step on the scale this week',
    body,
    evidence: [
      { label: 'Weigh-ins in 4 weeks', value: String(readings) },
      { label: 'For a good read', value: String(WEIGH_INS_FOR_A_READ) },
    ],
    payload: { action: 'log_weight', route: '/(app)/analytics' },
    signals: ['finding_maintenance', ...missing],
  };
}

function foodCard(d: Record<string, unknown>, missing: string[]): EnergyCard {
  return {
    kind: 'request',
    topic: 'log_food',
    title: 'Log whole days this week',
    // Only claim the weigh-ins are in when they are: this card also comes when
    // the weigh-in topic is muted and the scale is still missing.
    body: missing.includes('weigh_ins') || missing.includes('stale')
      ? 'Whole days of food, not just snacks, show me what you really eat. Four this week is a good start on your real maintenance.'
      : 'Your weigh-ins are the first half of the maths. Whole days of food, not just snacks, are the second. Four this week and I can tie the scale to what you eat.',
    evidence: [
      { label: 'Whole days in 4 weeks', value: String(n(d.whole_days) ?? 0) },
      { label: 'For a good read', value: String(WHOLE_DAYS_FOR_A_READ) },
    ],
    payload: { action: 'log_food', route: '/(app)/nutrition' },
    signals: ['finding_maintenance', ...missing],
  };
}

/** The card for this week, or null to let the other rules have their turn. */
export function decideEnergyCard(f: EnergyFacts, onCooldown: (topic: string) => boolean): EnergyCard | null {
  const rows = f.behaviours ?? [];
  const mutes = new Set(rows.flatMap((b) => strings(b.mutes)));
  const open = (topic: string) => !mutes.has(`topic:${topic}`) && !onCooldown(topic);

  const cal = rows.find((b) => b.behaviour === 'calories_off');
  if (cal && open('calories') && isProTier(f.tier, f.tier_expires_at, f.as_of ?? '')) {
    const d = cal.detail ?? {};
    const live = n(f.targets?.kcal);
    const to = nextTarget(live, n(d.suggested_kcal), n(d.floor_kcal));
    if (live != null && to != null) return caloriesCard(f, d, live, to);
  }

  const find = rows.find((b) => b.behaviour === 'finding_maintenance');
  if (find) {
    const d = find.detail ?? {};
    const missing = strings(d.missing);
    const needsScale = missing.includes('weigh_ins') || missing.includes('stale') || missing.includes('scale');
    if (needsScale && open('weigh_in')) return weighInCard(d, missing);
    if (missing.includes('whole_days') && open('log_food')) return foodCard(d, missing);
  }
  return null;
}
