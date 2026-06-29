/**
 * Readiness score (holistic tracking, Phase 2).
 *
 * A single 0-100 number Drona narrates, composed from recovery signals against
 * the user's OWN rolling baseline (not population norms). Three tiers degrade
 * gracefully by what data exists (plan .planning/holistic-tracking-plan.md s5):
 *   A1  objective, HRV present (Apple Watch / Garmin): HRV + RHR + sleep
 *   A2  objective, HRV absent (Whoop / Oura): RHR + sleep, reweighted
 *   B   subjective fallback: the recovery/mood check-in (phone-only)
 *
 * This module is PURE (no DB, no native, no Date) so it is unit-testable and
 * deterministic. The caller supplies today's values, the baseline stats, and an
 * optional acute-load + subjective input. Diet is intentionally NOT a factor
 * here (owned by the diet workstream); a neutral hook can be added later.
 */

import { Colors } from '@/constants/theme';

/** Trailing-window stats for one signal (mean/sd over the baseline period). */
export interface BaselineStat {
  mean: number | null;
  sd: number | null;
  /** Number of days the baseline is built from; gates whether we trust it. */
  n: number;
}

export interface ReadinessInput {
  today: {
    sleepMinutes?: number | null;
    restingHrBpm?: number | null;
    hrvMs?: number | null;
  };
  baseline: {
    sleepMinutes?: BaselineStat;
    restingHrBpm?: BaselineStat;
    hrvMs?: BaselineStat;
  };
  /** Optional acute training load: recent vs typical weekly set count. */
  acuteLoad?: { last7dSets: number; typicalWeeklySets: number } | null;
  /** Optional subjective check-in, 1-5 Likert (higher = better, except soreness). */
  subjective?: {
    mood?: number | null;
    energy?: number | null;
    soreness?: number | null;
    sleepQuality?: number | null;
  } | null;
}

export type ReadinessTier = 'A1' | 'A2' | 'B' | 'none';
export type ReadinessBand = 'low' | 'moderate' | 'high';

export interface ReadinessContributor {
  key: 'hrv' | 'rhr' | 'sleep' | 'load' | 'subjective';
  z?: number;
  note: string;
}

export interface ReadinessResult {
  /** 0-100, or null when there is not enough data to say anything honest. */
  score: number | null;
  tier: ReadinessTier;
  band: ReadinessBand | null;
  /** Short, Drona-voiced rationale (no em dashes). */
  rationale: string;
  contributors: ReadinessContributor[];
  /** True while the baseline is still calibrating (objective tiers need history). */
  calibrating: boolean;
}

/** Min days of baseline before an objective signal is trusted. */
const MIN_BASELINE_DAYS = 7;
const Z_CLAMP = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** z-score of `value` against a baseline, clamped; null if baseline unusable. */
function zScore(value: number | null | undefined, base: BaselineStat | undefined, invert = false): number | null {
  if (value == null || !base || base.mean == null || base.sd == null) return null;
  if (base.n < MIN_BASELINE_DAYS || base.sd <= 0) return null;
  const raw = (value - base.mean) / base.sd;
  return clamp(invert ? -raw : raw, -Z_CLAMP, Z_CLAMP);
}

/** Map a weighted z (roughly -3..3) to a 0-100 score. z=0 -> 50, z=+3.3 -> 100. */
function zToScore(z: number): number {
  return Math.round(clamp(50 + 15 * z, 0, 100));
}

function bandFor(score: number): ReadinessBand {
  if (score < 40) return 'low';
  if (score <= 66) return 'moderate';
  return 'high';
}

function subjectiveScore(s: NonNullable<ReadinessInput['subjective']>): number | null {
  // Normalize each 1-5 to 0-100; soreness is inverted (more soreness = worse).
  const parts: number[] = [];
  const norm = (x: number) => ((clamp(x, 1, 5) - 1) / 4) * 100;
  if (s.mood != null) parts.push(norm(s.mood));
  if (s.energy != null) parts.push(norm(s.energy));
  if (s.sleepQuality != null) parts.push(norm(s.sleepQuality));
  if (s.soreness != null) parts.push(norm(6 - clamp(s.soreness, 1, 5)));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/**
 * Compute readiness. Deterministic and side-effect free.
 *
 * The objective tiers blend z-scores of the available signals (HRV up = good,
 * RHR down = good, sleep up = good) weighted by tier, then temper by acute load.
 * When no objective signal is usable, fall back to the subjective check-in (B).
 */
export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const contributors: ReadinessContributor[] = [];

  const zHrv = zScore(input.today.hrvMs, input.baseline.hrvMs);
  const zRhr = zScore(input.today.restingHrBpm, input.baseline.restingHrBpm, true);
  const zSleep = zScore(input.today.sleepMinutes, input.baseline.sleepMinutes);

  const haveHrv = zHrv != null;
  const haveObjective = zHrv != null || zRhr != null || zSleep != null;

  // Did the user supply today's objective values but the baseline isn't ready?
  const hasTodayObjective =
    input.today.hrvMs != null || input.today.restingHrBpm != null || input.today.sleepMinutes != null;
  const calibrating = hasTodayObjective && !haveObjective;

  if (haveObjective) {
    // Tier weights; renormalized over the signals actually present.
    const weights = haveHrv
      ? { hrv: 0.5, rhr: 0.3, sleep: 0.2 }
      : { hrv: 0, rhr: 0.5, sleep: 0.5 };
    let wSum = 0;
    let zSum = 0;
    if (zHrv != null) { zSum += weights.hrv * zHrv; wSum += weights.hrv; contributors.push({ key: 'hrv', z: zHrv, note: 'HRV vs your baseline' }); }
    if (zRhr != null) { zSum += weights.rhr * zRhr; wSum += weights.rhr; contributors.push({ key: 'rhr', z: zRhr, note: 'resting heart rate vs your baseline' }); }
    if (zSleep != null) { zSum += weights.sleep * zSleep; wSum += weights.sleep; contributors.push({ key: 'sleep', z: zSleep, note: 'sleep vs your baseline' }); }

    const weightedZ = wSum > 0 ? zSum / wSum : 0;
    let score = zToScore(weightedZ);

    // Acute-load temper: well above typical weekly volume eats into headroom.
    if (input.acuteLoad && input.acuteLoad.typicalWeeklySets > 0) {
      const ratio = input.acuteLoad.last7dSets / input.acuteLoad.typicalWeeklySets;
      if (ratio > 1.3) {
        const penalty = Math.round(clamp((ratio - 1.3) * 20, 0, 10));
        if (penalty > 0) {
          score = clamp(score - penalty, 0, 100);
          contributors.push({ key: 'load', note: `recent training load ${Math.round(ratio * 100)}% of typical` });
        }
      }
    }

    const tier: ReadinessTier = haveHrv ? 'A1' : 'A2';
    const band = bandFor(score);
    return { score, tier, band, calibrating: false, rationale: rationaleFor(score, band, tier), contributors };
  }

  // Tier B: subjective check-in fallback.
  if (input.subjective) {
    const s = subjectiveScore(input.subjective);
    if (s != null) {
      const band = bandFor(s);
      contributors.push({ key: 'subjective', note: 'your check-in' });
      return { score: s, tier: 'B', band, calibrating, rationale: rationaleFor(s, band, 'B'), contributors };
    }
  }

  return {
    score: null,
    tier: 'none',
    band: null,
    calibrating,
    rationale: calibrating
      ? 'Still learning your baseline. Give it a week or two of data and readiness kicks in.'
      : 'No recovery data yet. Connect a wearable or log a quick check-in.',
    contributors,
  };
}

function rationaleFor(score: number, band: ReadinessBand, tier: ReadinessTier): string {
  const lens = tier === 'B' ? 'how you feel today' : tier === 'A2' ? 'your sleep and resting heart rate' : 'your recovery markers';
  if (band === 'high') return `Readiness ${score}. ${capitalize(lens)} look strong, so push today.`;
  if (band === 'moderate') return `Readiness ${score}. ${capitalize(lens)} are about normal, so train as planned.`;
  return `Readiness ${score}. ${capitalize(lens)} are down, so ease off and protect recovery.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The tier weight a recovery signal carries in the score (mirrors computeReadiness). */
export function contributorWeight(tier: ReadinessTier, key: ReadinessContributor['key']): number {
  if (tier !== 'A1' && tier !== 'A2') return 0;
  const w: Record<string, number> = tier === 'A1'
    ? { hrv: 0.5, rhr: 0.3, sleep: 0.2 }
    : { hrv: 0, rhr: 0.5, sleep: 0.5 };
  return w[key] ?? 0;
}

/** Signed pull this contributor had on today's score (weight x deviation). */
export function contributorImpact(tier: ReadinessTier, c: ReadinessContributor): number {
  if (c.z == null) return 0;
  return contributorWeight(tier, c.key) * c.z;
}

/** Band for a raw 0-100 score (exposed so the trend can colour its latest point). */
export function bandForScore(score: number): ReadinessBand {
  return bandFor(score);
}

/** Vivid band base colour for the ring stroke + directive pill fill. */
export function bandColor(band: ReadinessBand): string {
  if (band === 'high') return Colors.success;
  if (band === 'moderate') return Colors.warning;
  return Colors.danger;
}

/** Two-to-three word directive derived from the band (Drona voice, no em dashes). */
export function directive(band: ReadinessBand): string {
  if (band === 'high') return 'Push today';
  if (band === 'moderate') return 'Train as planned';
  return 'Ease off today';
}

/** AA-tuned band text colour; pass the active theme object from useTheme(). */
export function bandTextColor(
  band: ReadinessBand,
  C: { successText: string; warningText: string; dangerText: string },
): string {
  if (band === 'high') return C.successText;
  if (band === 'moderate') return C.warningText;
  return C.dangerText;
}

/**
 * Directive-pill text colour. Same as bandTextColor except the low/danger red is
 * lifted on dark, where #ef4444 over a 12% danger fill dips below WCAG AA; light
 * keeps its darker red, which already passes on the cream card.
 */
export function bandPillTextColor(
  band: ReadinessBand,
  C: { successText: string; warningText: string; dangerText: string },
): string {
  if (band !== 'low') return bandTextColor(band, C);
  return C.dangerText === '#ef4444' ? '#f87171' : C.dangerText;
}
