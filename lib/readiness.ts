/**
 * Readiness score (holistic tracking, Phase 2).
 *
 * A single 0-100 number Drona narrates, composed from recovery signals against
 * the user's OWN rolling baseline. Sleep is the anchor of every tier: with no
 * sleep signal (synced OR logged by hand) there is no score. The other signals
 * layer on top as they become available, so a phone-only user still gets a read:
 *   A1  HRV + resting HR + sleep (Apple Watch / Garmin)
 *   A2  resting HR + sleep (Whoop / Oura, or a chest strap)
 *   A3  sleep only (phone-only: a manual sleep log, or sleep from the hub)
 *
 * Cold start: until the personal sleep baseline has enough history, sleep scores
 * against a population prior and the result is flagged `provisional` (an honest
 * "early read" the UI labels). HRV/RHR get no prior (inter-individual variance
 * makes a population HRV number meaningless), so they only join once the user's
 * OWN baseline is built.
 *
 * This module is PURE (no DB, no native, no Date) so it is unit-testable and
 * deterministic. The caller supplies today's values, the baseline stats, and
 * optional acute-load + nutrition inputs. Training load tempers the score down
 * when volume spikes; nutrition tempers both ways (modestly) when the user logs
 * food. Both are bounded so sleep stays the anchor.
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
    /** Subjective 1-5 rating logged alongside a manual sleep entry (5 = best). */
    sleepQuality?: number | null;
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
  /**
   * Optional nutrition signal, only when the user logs food. Ratios of recent
   * intake to the user's targets, pre-averaged over the last few COMPLETED days
   * (not today, which is still being eaten) by the sync layer, since overnight
   * recovery runs on fuel already consumed. null when nothing was logged.
   */
  nutrition?: { proteinRatio: number; energyRatio: number } | null;
}

export type ReadinessTier = 'A1' | 'A2' | 'A3' | 'none';
export type ReadinessBand = 'low' | 'moderate' | 'high';

export interface ReadinessContributor {
  key: 'hrv' | 'rhr' | 'sleep' | 'load' | 'diet';
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
  /**
   * True when the sleep component is scored against the population prior rather
   * than the user's own (not-yet-built) baseline. The UI labels this an "early
   * read"; it flips false once >= MIN_BASELINE_DAYS of personal sleep exist.
   */
  provisional: boolean;
}

/** Min days of baseline before a PERSONAL signal is trusted. */
const MIN_BASELINE_DAYS = 7;
const Z_CLAMP = 3;

/**
 * Population sleep prior for the cold-start (provisional) window: 7h45 center of
 * the 7-9h adult band, sd wide enough that a normal night reads near-neutral.
 * Only sleep gets a prior; HRV/RHR are too person-specific to seed this way.
 */
const SLEEP_PRIOR: BaselineStat = { mean: 465, sd: 75, n: MIN_BASELINE_DAYS };

/**
 * Minimum SD per signal, so a coarse logger (a user who always types "8h") can't
 * collapse their baseline sd toward 0 and turn a 30-minute wobble into a huge
 * z-score. Applied only to PERSONAL baselines (the prior's sd is already sane).
 */
const SD_FLOOR = { sleep: 30, rhr: 2, hrv: 6 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * z-score of `value` against a PERSONAL baseline, clamped; null if the baseline
 * has too little history. `floor` guarantees a positive sd (so the sd<=0 case is
 * subsumed), which is why there is no separate sd<=0 bail-out here.
 */
function zPersonal(
  value: number | null | undefined,
  base: BaselineStat | undefined,
  floor: number,
  invert = false,
): number | null {
  if (value == null || !base || base.mean == null || base.sd == null) return null;
  if (base.n < MIN_BASELINE_DAYS) return null;
  const sd = Math.max(base.sd, floor);
  const raw = (value - base.mean) / sd;
  return clamp(invert ? -raw : raw, -Z_CLAMP, Z_CLAMP);
}

/** z-score of `value` against a fixed population prior, clamped. */
function zPrior(value: number | null | undefined, prior: BaselineStat): number | null {
  if (value == null || prior.mean == null || prior.sd == null || prior.sd <= 0) return null;
  return clamp((value - prior.mean) / prior.sd, -Z_CLAMP, Z_CLAMP);
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

/**
 * Anchored pseudo-z for a 1-5 sleep-quality rating: 3 = "normal" (z 0), each
 * point ~0.8 sd, capped so quality alone can't dominate the blend. Needs no
 * baseline (the anchor is fixed), which is why it works from day one.
 */
function qualityZ(quality: number | null | undefined): number | null {
  if (quality == null) return null;
  return clamp((clamp(quality, 1, 5) - 3) * 0.8, -1.6, 1.6);
}

/** Max points nutrition can move the score, either way (kept small; sleep leads). */
const MAX_DIET_ADJUST = 5;

/**
 * Diet temper in points, -MAX..+MAX. Protein adequacy is the primary driver
 * (protein repairs the work training does): at/over target lifts, well under
 * drags. A severe energy deficit (under ~80% of needs) adds a secondary drag,
 * since under-fueling blunts recovery; eating at or above target is not penalized
 * (a surplus does not "super-charge" recovery). Ratios are intake / target.
 */
function dietAdjustment(n: { proteinRatio: number; energyRatio: number }): number {
  // protein: 1.0 target -> +1, 0.75 -> 0, 0.5 -> -1 (clamped).
  const proteinScore = clamp((n.proteinRatio - 0.75) / 0.25, -1, 1);
  // energy: only the downside. 0.8 -> 0, 0.5 -> -1; at/over target -> 0.
  const energyScore = n.energyRatio < 0.8 ? clamp((n.energyRatio - 0.8) / 0.3, -1, 0) : 0;
  const raw = 0.7 * proteinScore + 0.3 * energyScore;
  return Math.round(clamp(raw * MAX_DIET_ADJUST, -MAX_DIET_ADJUST, MAX_DIET_ADJUST));
}

/** Plain-language note for the diet contributor, by direction (no em dashes). */
function dietNote(delta: number): string {
  if (delta > 0) return 'Your recent fueling supports recovery.';
  if (delta < 0) return 'Recent fueling came up short, so readiness eased down.';
  return 'Your recent fueling looks about right.';
}

/**
 * Compute readiness. Deterministic and side-effect free.
 *
 * Sleep is the anchor: build its z (duration vs personal baseline, or vs the
 * population prior while calibrating, blended with the optional quality rating).
 * With no sleep z there is no score, full stop. Otherwise layer HRV and RHR on
 * top when the user's OWN baseline supports them, blend by tier weight, and
 * temper by acute training load.
 */
export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const contributors: ReadinessContributor[] = [];

  // ── Sleep component (the anchor) ────────────────────────────────────────────
  const sleepBase = input.baseline.sleepMinutes;
  const sleepReady = !!sleepBase && sleepBase.mean != null && sleepBase.sd != null && sleepBase.n >= MIN_BASELINE_DAYS;
  let zDur: number | null;
  let provisional = false;
  if (input.today.sleepMinutes == null) {
    zDur = null;
  } else if (sleepReady) {
    zDur = zPersonal(input.today.sleepMinutes, sleepBase, SD_FLOOR.sleep);
  } else {
    // Cold start: score duration against the population prior, flag it honest.
    zDur = zPrior(input.today.sleepMinutes, SLEEP_PRIOR);
    provisional = zDur != null;
  }
  const zQual = qualityZ(input.today.sleepQuality);
  // Duration is required. Quality only modulates a present duration; a quality
  // rating with no duration (only reachable via direct DB writes) does not score.
  const zSleep =
    zDur != null && zQual != null ? 0.65 * zDur + 0.35 * zQual
    : zDur != null ? zDur
    : null;

  if (zSleep == null) {
    return {
      score: null,
      tier: 'none',
      band: null,
      provisional: false,
      rationale: 'No sleep yet. Log last night or wear your tracker to bed, and readiness kicks in.',
      contributors,
    };
  }

  // ── Layered recovery signals (personal baseline only) ───────────────────────
  const zHrv = zPersonal(input.today.hrvMs, input.baseline.hrvMs, SD_FLOOR.hrv);
  const zRhr = zPersonal(input.today.restingHrBpm, input.baseline.restingHrBpm, SD_FLOOR.rhr, true);
  const haveRhr = zRhr != null;
  // HRV only counts alongside RHR (they come from the same wearable). This keeps
  // the A1 tier honest: it never labels "HRV, resting heart rate and sleep" or
  // folds HRV into the score when resting HR is absent. A lone HRV reading (rare)
  // falls through to sleep-only rather than inventing a half-A1.
  const haveHrv = zHrv != null && haveRhr;

  // Tier weights; renormalized below over the signals actually present.
  const weights = haveHrv ? { hrv: 0.5, rhr: 0.3, sleep: 0.2 } : { hrv: 0, rhr: 0.5, sleep: 0.5 };
  let wSum = 0;
  let zSum = 0;
  if (haveHrv && zHrv != null) { zSum += weights.hrv * zHrv; wSum += weights.hrv; contributors.push({ key: 'hrv', z: zHrv, note: 'HRV vs your baseline' }); }
  if (zRhr != null) { zSum += weights.rhr * zRhr; wSum += weights.rhr; contributors.push({ key: 'rhr', z: zRhr, note: 'resting heart rate vs your baseline' }); }
  zSum += weights.sleep * zSleep; wSum += weights.sleep; contributors.push({ key: 'sleep', z: zSleep, note: 'sleep vs your baseline' });

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

  // Nutrition temper (only when the user logs food): well-fueled recovery nudges
  // up, under-fueled nudges down, bounded so sleep stays the anchor. A diet
  // contributor is recorded whenever nutrition is present (even at delta 0) so the
  // UI can honestly say nutrition is being factored in.
  if (input.nutrition) {
    const delta = dietAdjustment(input.nutrition);
    if (delta !== 0) score = clamp(score + delta, 0, 100);
    contributors.push({ key: 'diet', note: dietNote(delta) });
  }

  const tier: ReadinessTier = haveHrv ? 'A1' : haveRhr ? 'A2' : 'A3';
  const band = bandFor(score);
  return { score, tier, band, provisional, rationale: rationaleFor(score, band, tier), contributors };
}

function rationaleFor(score: number, band: ReadinessBand, tier: ReadinessTier): string {
  const lens = tier === 'A3' ? 'your sleep' : tier === 'A2' ? 'your sleep and resting heart rate' : 'your recovery markers';
  // The A3 lens ("your sleep") is singular; the A1/A2 lenses are plural. Agree the
  // verb so the narration doesn't read "your sleep are down…".
  const singular = tier === 'A3';
  if (band === 'high') return `Readiness ${score}. ${capitalize(lens)} ${singular ? 'looks' : 'look'} strong, so push today.`;
  if (band === 'moderate') return `Readiness ${score}. ${capitalize(lens)} ${singular ? 'is' : 'are'} about normal, so train as planned.`;
  return `Readiness ${score}. ${capitalize(lens)} ${singular ? 'is' : 'are'} down, so ease off and protect recovery.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The tier weight a recovery signal carries in the score (mirrors computeReadiness). */
export function contributorWeight(tier: ReadinessTier, key: ReadinessContributor['key']): number {
  if (tier === 'none') return 0;
  const w: Record<string, number> = tier === 'A1'
    ? { hrv: 0.5, rhr: 0.3, sleep: 0.2 }
    : tier === 'A2'
      ? { hrv: 0, rhr: 0.5, sleep: 0.5 }
      : { hrv: 0, rhr: 0, sleep: 1.0 };
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
