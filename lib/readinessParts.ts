/**
 * Saves what went into a readiness score (readiness_parts, migration 0144), so
 * the coach can see WHY a number is what it is, and which signals could not be
 * read. Kept apart from readinessSync.ts, which pulls in native health modules,
 * so a script can run this exact code against the database.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReadinessResult } from './readiness';

const round2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);

/** The row for one local day. Saved even with no score: "opened, no sleep" is a fact too. */
export function readinessPartsRow(userId: string, day: string, result: ReadinessResult) {
  const p = result.parts;
  return {
    user_id: userId,
    metric_date: day,
    formula: p.formula,
    score: result.score,
    tier: result.tier,
    band: result.band,
    provisional: result.provisional,
    sleep_basis: p.sleep.basis,
    sleep_points: round2(p.sleep.points),
    rhr_why: p.rhr.why,
    rhr_points: round2(p.rhr.points),
    hrv_why: p.hrv.why,
    hrv_points: round2(p.hrv.points),
    base_score: p.baseScore,
    load_points: p.load?.points ?? null,
    diet_points: p.diet?.points ?? null,
    parts: p,
  };
}

/**
 * Best effort: returns the error instead of throwing, and the caller ignores it,
 * so the person's score never depends on the parts being saved.
 */
export async function storeReadinessParts(
  supabase: SupabaseClient,
  userId: string,
  day: string,
  result: ReadinessResult,
): Promise<unknown> {
  try {
    const { error } = await supabase
      .from('readiness_parts')
      .upsert(readinessPartsRow(userId, day, result), { onConflict: 'user_id,metric_date' });
    return error ?? null;
  } catch (e) {
    return e;
  }
}
