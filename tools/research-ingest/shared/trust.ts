/**
 * Trust scoring v2 (Phase 3).
 *
 * Augments the study-design heuristic from v1 with two real-world signals:
 *
 *   1. Author h-index   — via Semantic Scholar's free API. We use the MAX
 *                          h-index across the paper's authors (one
 *                          well-credentialed author lends authority).
 *   2. Citation count    — same API. "influentialCitationCount" is even
 *                          better signal than raw citations but we fall
 *                          back to total if missing.
 *   3. Journal tier      — local lookup map (shared/journals.ts).
 *
 * All three are folded into a single 0–1 score. The base score still comes
 * from study_design (meta-analysis dominates RCT dominates observational);
 * the others are additive bumps and dings. Final score clamped to [0, 1].
 *
 * Failure handling: Semantic Scholar errors / rate limits don't block
 * ingest. The function returns whatever signals it could fetch; missing
 * ones are treated as neutral (no bump, no penalty). So worst case we
 * fall back to v1 quality.
 */
import { SEMANTIC_SCHOLAR_API_KEY } from './env.js';
import { log } from './log.js';
import { journalTier, type JournalTier } from './journals.js';
import type { Paper, Distillation } from './types.js';

// ── Semantic Scholar lookup ────────────────────────────────────────────────
const SEMANTIC_SCHOLAR_URL = 'https://api.semanticscholar.org/graph/v1/paper';

interface SemanticScholarPaper {
  paperId?: string;
  authors?: Array<{ name?: string; hIndex?: number }>;
  citationCount?: number;
  influentialCitationCount?: number;
  journal?: { name?: string };
  year?: number;
}

export interface AuthorityEnrichment {
  /** Max h-index across authors. 0 if none reported. */
  authorMaxHIndex: number;
  /** Total citation count. -1 if not available. */
  citationCount: number;
  /** Influential citation count (subset of total). -1 if not available. */
  influentialCitationCount: number;
  /** Journal name as reported by Semantic Scholar. */
  journalName: string | null;
  /** Tier from journals.ts lookup (1=top, 4=unknown). */
  journalTier: JournalTier;
  /** Source of the enrichment for audit. */
  source: 'semantic_scholar' | 'fallback';
}

/** Empty enrichment used when the API isn't available or fails. */
function fallbackEnrichment(paper: Paper): AuthorityEnrichment {
  return {
    authorMaxHIndex: 0,
    citationCount: -1,
    influentialCitationCount: -1,
    journalName: paper.journal ?? null,
    journalTier: journalTier(paper.journal),
    source: 'fallback',
  };
}

/**
 * Best-effort lookup. Uses DOI when available (most reliable), falls back
 * to PMID. Returns fallback enrichment on any API failure — never throws.
 */
export async function enrichAuthority(paper: Paper): Promise<AuthorityEnrichment> {
  const meta = paper.source_meta ?? {};
  const doi = typeof meta.doi === 'string' ? meta.doi : undefined;
  const pmid = typeof meta.pmid === 'string' ? meta.pmid : undefined;

  // Semantic Scholar accepts DOI:<doi>, PMID:<pmid>, ARXIV:<id>, etc. as
  // path-segment identifiers. DOI is the most universal.
  let id: string | undefined;
  if (doi) id = `DOI:${doi}`;
  else if (pmid) id = `PMID:${pmid}`;
  if (!id) {
    log.warn('trust', 'no DOI/PMID for enrichment; using fallback', { url: paper.url });
    return fallbackEnrichment(paper);
  }

  const url = `${SEMANTIC_SCHOLAR_URL}/${encodeURIComponent(id)}?fields=authors.hIndex,citationCount,influentialCitationCount,journal,year`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (SEMANTIC_SCHOLAR_API_KEY) {
    headers['x-api-key'] = SEMANTIC_SCHOLAR_API_KEY;
  }

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // 404 = paper not yet indexed by SS (common for very recent preprints).
      // 429 = rate-limited (we're <100 req/5min unauth, but other workloads
      // on the same IP can compete). Both are non-fatal.
      if (res.status === 404) {
        log.info('trust', 'paper not in Semantic Scholar (404)', { id, url: paper.url });
      } else {
        log.warn('trust', `Semantic Scholar ${res.status}; using fallback`, {
          id, url: paper.url,
        });
      }
      return fallbackEnrichment(paper);
    }
    const data = (await res.json()) as SemanticScholarPaper;
    const authorMaxHIndex = (data.authors ?? []).reduce((max, a) => {
      const h = typeof a.hIndex === 'number' ? a.hIndex : 0;
      return h > max ? h : max;
    }, 0);
    const journalName = data.journal?.name ?? paper.journal ?? null;
    return {
      authorMaxHIndex,
      citationCount: typeof data.citationCount === 'number' ? data.citationCount : -1,
      influentialCitationCount: typeof data.influentialCitationCount === 'number'
        ? data.influentialCitationCount
        : -1,
      journalName,
      journalTier: journalTier(journalName),
      source: 'semantic_scholar',
    };
  } catch (e) {
    log.warn('trust', `Semantic Scholar threw; using fallback`, {
      error: String(e).slice(0, 200), url: paper.url,
    });
    return fallbackEnrichment(paper);
  }
}

// ── Score combination ───────────────────────────────────────────────────────
/**
 * v2 trust score:
 *
 *   base from study_design (0.4 – 0.85)
 *   + 0.00 → 0.10 for author authority (h-index)
 *   + 0.00 → 0.05 for citation count
 *   ±  for journal tier
 *   ± confidence adjustment from the distillation
 *
 * Clamped to [0.20, 0.95] — we never trust at 1.0 (uncertainty is real),
 * and very-low scores still leave room for retrieval to surface them as
 * weak signal rather than disappearing.
 */
export function trustScoreV2(
  dist: Distillation,
  authority: AuthorityEnrichment,
): number {
  // Base from study design (same as v1).
  let s = 0.5;
  if (dist.study_design === 'meta-analysis' || dist.study_design === 'systematic-review') s = 0.85;
  else if (dist.study_design === 'RCT') s = 0.7;
  else if (dist.study_design === 'crossover') s = 0.65;
  else if (dist.study_design === 'cohort') s = 0.55;
  else if (dist.study_design === 'observational') s = 0.45;
  else if (dist.study_design === 'narrative-review') s = 0.5;
  else if (dist.study_design === 'preprint') s = 0.4;

  // Author authority — diminishing returns past h-index 30.
  if (authority.authorMaxHIndex >= 50) s += 0.10;
  else if (authority.authorMaxHIndex >= 30) s += 0.07;
  else if (authority.authorMaxHIndex >= 15) s += 0.04;
  else if (authority.authorMaxHIndex >= 5) s += 0.02;

  // Citation signal — prefer influential count when available, otherwise
  // raw total. Caveat: papers <2 years old won't have many citations yet,
  // so we don't penalize 0; we just don't bonus it.
  const cites = authority.influentialCitationCount >= 0
    ? authority.influentialCitationCount * 3      // 1 influential ≈ 3 raw
    : Math.max(0, authority.citationCount);
  if (cites >= 100) s += 0.05;
  else if (cites >= 30) s += 0.03;
  else if (cites >= 10) s += 0.01;

  // Journal tier — small bonus for top, penalty for unknown.
  if (authority.journalTier === 1) s += 0.05;
  else if (authority.journalTier === 2) s += 0.02;
  else if (authority.journalTier === 3) s += 0.00; // neutral
  else if (authority.journalTier === 4) s -= 0.05; // unknown penalty

  // Distillation confidence (same as v1).
  if (dist.confidence === 'replicated') s = Math.min(0.95, s + 0.05);
  else if (dist.confidence === 'preliminary') s = Math.max(0.20, s - 0.10);

  // Final clamp.
  s = Math.max(0.20, Math.min(0.95, s));
  return Math.round(s * 100) / 100;
}
