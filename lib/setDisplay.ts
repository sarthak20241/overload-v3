// Metric-aware SET DISPLAY helpers — the single source for "how does one logged
// set read" and "what's the headline best" across every read surface (history,
// dashboard, analytics PR card + progress chart, coach recap). Extracted from
// history.tsx so weight-only screens stop showing "0 reps" / "PR: 0kg" for
// bodyweight, duration, distance and resistance work. Pairs with lib/sets.ts
// (volume math); this module owns presentation, that one owns the kg total.

import { MetricType, metricTypeDef, metricTypeOf } from '@/lib/exercises';
import { formatWeight, formatDuration, formatDistanceKm } from '@/lib/format';

/** Fields any set-shaped object needs to render. Superset of VolumeSet. */
export interface DisplaySet {
  weight_kg: number;
  reps: number;
  duration_seconds?: number | null;
  distance_m?: number | null;
  resistance?: number | null;
  set_type?: string | null;
  is_unilateral?: boolean | null;
  reps_right?: number | null;
  weight_kg_right?: number | null;
}

const hasWeightAxis = (axes: readonly string[]) =>
  axes.some((a) => a === 'weight' || a === 'added_weight' || a === 'assist_weight');

/**
 * Per-set pill text, axis-aware ("60kg × 8", "+10kg × 6", "0:45", "5km", "Lv 12",
 * "12"). A unilateral set with differing per-side loads spells both sides out.
 * One source for history, the dashboard expanded rows, and anywhere a set reads back.
 */
export function setLabel(metricType: MetricType, s: DisplaySet): string {
  const axes = metricTypeDef(metricType).axes;
  // Per-side weight (migration 0059): a unilateral set whose two sides used
  // different loads spells both out ("40kg×8 / 35kg×7"); equal weights stay compact.
  if (s.is_unilateral && hasWeightAxis(axes) && axes.includes('reps')
      && s.weight_kg_right != null && s.weight_kg_right !== s.weight_kg) {
    const pre = axes.includes('assist_weight') ? '-' : axes.includes('added_weight') ? '+' : '';
    return `${pre}${formatWeight(s.weight_kg)}kg×${s.reps} / ${pre}${formatWeight(s.weight_kg_right)}kg×${s.reps_right ?? 0}`;
  }
  const parts = axes.map((a) =>
    // A unilateral set shows both sides on the reps axis (weight is shared).
    a === 'reps' ? (s.is_unilateral ? `${s.reps}/${s.reps_right ?? 0}` : `${s.reps}`)
    : a === 'duration' ? formatDuration(s.duration_seconds)
    : a === 'distance' ? `${formatDistanceKm(s.distance_m)}km`
    : a === 'resistance' ? `Lv ${s.resistance ?? 0}`
    : a === 'assist_weight' ? `-${formatWeight(s.weight_kg)}kg`
    : a === 'added_weight' ? `+${formatWeight(s.weight_kg)}kg`
    : `${formatWeight(s.weight_kg)}kg`,
  );
  return hasWeightAxis(axes) && axes.includes('reps') ? parts.join(' × ') : parts.join(' · ');
}

/** The axis whose magnitude is an exercise's headline "best" (heaviest/longest/farthest/most). */
export type PrimaryAxis = 'weight' | 'reps' | 'duration' | 'distance';

/**
 * Which axis carries the headline number for a metric type. Mirrors the
 * precedence history already used: distance > pure-duration > weight > reps, so
 * a carry reads by distance, a plank by time, a lift by load, pull-ups by reps.
 */
export function primaryAxisOf(metricType: MetricType): PrimaryAxis {
  const axes = metricTypeDef(metricType).axes;
  if (axes.includes('distance')) return 'distance';
  if (axes.includes('duration') && !hasWeightAxis(axes)) return 'duration';
  if (hasWeightAxis(axes)) return 'weight';
  return 'reps';
}

/** True when an exercise's headline is a weight in kg (so "Max Weight"/PR-in-kg is meaningful). */
export function isWeightPrimary(metricType: MetricType): boolean {
  return primaryAxisOf(metricType) === 'weight';
}

/** This set's magnitude on the primary axis (counts the heavier/more side of a unilateral set). */
function setPrimaryValue(axis: PrimaryAxis, s: DisplaySet): number {
  switch (axis) {
    case 'distance': return s.distance_m ?? 0;
    case 'duration': return s.duration_seconds ?? 0;
    case 'weight': return Math.max(s.weight_kg ?? 0, s.weight_kg_right ?? 0);
    case 'reps': return Math.max(s.reps ?? 0, s.reps_right ?? 0);
  }
}

/**
 * Canonical numeric best across sets, in the primary axis's native unit
 * (kg / reps / seconds / metres). Used for charting and PR ranking; pair with
 * formatPrimaryValue for display. Higher is always better.
 */
export function setBestValue(metricType: MetricType, sets: DisplaySet[]): number {
  const axis = primaryAxisOf(metricType);
  return Math.max(0, ...sets.map((s) => setPrimaryValue(axis, s)));
}

/** Format a primary-axis magnitude (from setBestValue) with its unit: "80kg", "12 reps", "2:30", "5km". */
export function formatPrimaryValue(metricType: MetricType, value: number): string {
  switch (primaryAxisOf(metricType)) {
    case 'distance': return `${formatDistanceKm(value)}km`;
    case 'duration': return formatDuration(value);
    case 'weight': return `${formatWeight(value)}kg`;
    case 'reps': return `${value} reps`;
  }
}

/** Headline "best" stat for an exercise's completed sets, formatted (heaviest/longest/farthest/most). */
export function setBestLabel(metricType: MetricType, sets: DisplaySet[]): string {
  return formatPrimaryValue(metricType, setBestValue(metricType, sets));
}

/** Toggle/label for the primary axis on charts and cards. */
export function primaryMetricLabel(metricType: MetricType): string {
  switch (primaryAxisOf(metricType)) {
    case 'distance': return 'Farthest';
    case 'duration': return 'Best Time';
    case 'weight': return 'Max Weight';
    case 'reps': return 'Best Reps';
  }
}
