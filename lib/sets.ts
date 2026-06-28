// Per-set helpers shared across the live logger, the edit screen, the coach recap
// and the persisted/server volume math, so the four sites never drift apart.

/** The fields any set-shaped object needs for a volume contribution. */
export interface VolumeSet {
  weight_kg: number;
  reps: number;
  set_type?: string | null;
  is_unilateral?: boolean | null;
  reps_right?: number | null;
  /** Per-side weight (migration 0059). null/undefined => same as weight_kg. */
  weight_kg_right?: number | null;
}

/**
 * Volume (kg) contributed by ONE set. Warmups contribute 0 (mirrors the server
 * recompute + all PR/volume math). A unilateral set adds the RIGHT side with its
 * own weight: weight_kg×reps + (weight_kg_right ?? weight_kg)×reps_right. Keep
 * this the single source of truth — the live memo, confirmFinish, the edit
 * recompute, analytics and the coach review total all call it, matching
 * recompute_user_volume_stat in SQL.
 */
export function setVolumeKg(s: VolumeSet): number {
  if (s.set_type === 'warmup') return 0;
  const right = s.is_unilateral ? (s.weight_kg_right ?? s.weight_kg) * (s.reps_right ?? 0) : 0;
  return s.weight_kg * s.reps + right;
}
