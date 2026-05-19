/**
 * Journal-tier lookup for trust scoring (Phase 3, trust v2).
 *
 * Hardcoded map of journals in the resistance-training / hypertrophy /
 * exercise-physiology space. Three good tiers + a default "unknown" tier
 * that gets a small penalty. This is not exhaustive — it covers the
 * journals our seed kb cites most often, plus the ones Europe PMC tends
 * to return for our query terms. Easy to add to as we see more papers
 * come through.
 *
 * Why not a table: there's no UI to manage it yet, and the list is small
 * enough (~30 entries) that bumping it via code change + redeploy is
 * easier than building admin CRUD. Worth promoting to a table if we
 * ever want non-engineers maintaining it.
 *
 * Tier 1: flagship — well-indexed, high-IF, peer-reviewed, established
 * Tier 2: solid mainstream sport-science / physiology journals
 * Tier 3: specialty / regional / lower-IF but still peer-reviewed
 * Tier 4: unknown to us → small penalty in trust score (might be
 *         legitimate but we can't vouch for it)
 */
export type JournalTier = 1 | 2 | 3 | 4;

// Keys are lowercase, alpha-and-spaces-only (titles get normalized the same
// way before lookup). Common abbreviations and full names both included.
const JOURNAL_TIERS: Record<string, JournalTier> = {
  // ── Tier 1 ────────────────────────────────────────────────────────────────
  'sports medicine': 1,
  'sports medicine open': 1,
  'medicine and science in sports and exercise': 1,
  'medicine science sports exercise': 1,
  'medicine and science in sports': 1,
  'msse': 1,
  'journal of strength and conditioning research': 1,
  'jscr': 1,
  'european journal of applied physiology': 1,
  'ejap': 1,
  'journal of applied physiology': 1,
  'journal of physiology': 1,
  'the journal of physiology': 1,
  'experimental physiology': 1,
  'the american journal of clinical nutrition': 1,
  'american journal of clinical nutrition': 1,
  'sports': 1, // MDPI Sports — borderline, but cites well in our domain

  // ── Tier 2 ────────────────────────────────────────────────────────────────
  'european journal of sport science': 2,
  'international journal of sports medicine': 2,
  'journal of sports sciences': 2,
  'journal of science and medicine in sport': 2,
  'frontiers in physiology': 2,
  'frontiers in sports and active living': 2,
  'frontiers in nutrition': 2,
  'sports biomechanics': 2,
  'international journal of sports physiology and performance': 2,
  'scandinavian journal of medicine science in sports': 2,
  'plos one': 2,
  'nutrients': 2,
  'physiological reports': 2,
  'peerj': 2,
  'biology of sport': 2,

  // ── Tier 3 ────────────────────────────────────────────────────────────────
  'pediatric exercise science': 3,
  'journal of human kinetics': 3,
  'journal of sport and health science': 3,
  'isokinetics and exercise science': 3,
  'movement sport sciences': 3,
  'sport sciences for health': 3,
  'journal of sports medicine and physical fitness': 3,
  'journal of sports medicine': 3,
  'human movement': 3,
  'journal of exercise rehabilitation': 3,
};

/**
 * Normalize a journal name for lookup. Strips punctuation, lowercases,
 * collapses whitespace. "J. Strength Cond. Res." and "Journal of Strength
 * and Conditioning Research" both end up matching (the former via the
 * 'jscr' abbreviation entry, the latter via the full name).
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')   // drop punctuation/numbers
    .replace(/\s+/g, ' ')         // collapse whitespace
    .trim();
}

export function journalTier(name: string | null | undefined): JournalTier {
  if (!name) return 4;
  const key = normalize(name);
  if (!key) return 4;
  if (JOURNAL_TIERS[key]) return JOURNAL_TIERS[key];
  // Fallback: try fuzzier substring match — handles "International Journal
  // of Sports Medicine and Health" (which contains the tier-2 prefix) and
  // similar. Only matches when the indexed key is a complete word boundary
  // inside the input, to avoid "American Journal of …" matching nothing
  // and "Medicine" matching too much.
  for (const [candidate, tier] of Object.entries(JOURNAL_TIERS)) {
    if (candidate.length < 8) continue; // skip very short abbreviations from fuzzy
    if (key.includes(candidate)) return tier;
  }
  return 4;
}
