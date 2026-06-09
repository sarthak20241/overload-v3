/**
 * Curated research ingestion (owner-driven, manual).
 *
 * The nightly worker (run.ts) is a query/trending firehose that lands
 * whatever Europe PMC / bioRxiv / SportRxiv surface for the day's topic
 * plan. This script is the opposite: a DELIBERATE, curated batch of the
 * best, most-trustable evidence across the topics our KB is thin on
 * (diet / sleep / cardio) plus a few landmark strength/hypertrophy reviews.
 *
 * It runs each paper through the EXACT SAME pipeline as the cron — relevance
 * filter, Haiku distillation + tagging, Voyage HyDE embedding, plagiarism
 * guard, trust-score v2, contradiction detection — and lands it in
 * research_kb_pending. Then it runs the SAME Sonnet auto-review agent, but
 * in ADVISORY mode: instead of applying the decision, it writes the agent's
 * verdict (add / skip) + reasoning into research_kb_pending.agent_recommendation
 * (migration 0032). The human makes the final approve/reject in the admin
 * review queue, now with the agent's remark in front of them.
 *
 * Sourcing: targeted Europe PMC queries scoped to high-evidence study types
 * (meta-analysis / systematic review, RCT where those are sparse) and sorted
 * most-cited-first so landmark papers surface. Every paper is a live API
 * result — real DOIs/abstracts, no hand-typed (hallucinatable) identifiers.
 *
 *   npx tsx tools/research-ingest/curated.ts --fetch-only   # free preview: list candidates, no LLM calls
 *   npx tsx tools/research-ingest/curated.ts --dry-run      # distill + score, print, NO DB writes
 *   npx tsx tools/research-ingest/curated.ts                # real run: land in pending + advisory agent review
 *   npx tsx tools/research-ingest/curated.ts --no-review    # skip the advisory Sonnet pass
 *   npx tsx tools/research-ingest/curated.ts --only=sleep   # run one topic (label substring match)
 *   npx tsx tools/research-ingest/curated.ts --max=20       # global cap on candidates processed
 */
import './shared/env.js';
import { assertRequiredEnv, PUBMED_CONTACT_EMAIL } from './shared/env.js';
import { log } from './shared/log.js';
import { distill } from './shared/anthropic.js';
import { embedDocumentsBatch, cosineSimilarity } from './shared/voyage.js';
import { isRelevant } from './shared/relevance.js';
import { buildHydePassage } from './shared/hyde.js';
import { makeServiceClient, isAlreadyIngested, insertPending } from './shared/supabase.js';
import { enrichAuthority, trustScoreV2 } from './shared/trust.js';
import { findConflicts, type ContradictionFlag } from './shared/contradictions.js';
import { runAgentReview, type PendingPaperForAgent } from './shared/agent-review.js';
import type { Paper, Distillation } from './shared/types.js';

// Same plagiarism threshold the cron uses (run.ts). A faithful HyDE
// distillation scores ~0.80-0.92 vs the abstract; near-verbatim copy is 0.95+.
const PLAGIARISM_THRESHOLD = 0.93;

// Free-tier rate limits force a slow, sequential cadence — the same reason
// the nightly cron runs one paper every ~22s:
//   • Voyage (no payment method): 3 RPM + 10K TPM → 1 embed call / ~22s is safe
//   • Anthropic (tier 1): 50K input-tokens/min → 1 distill + a few contradiction
//     Haiku calls per 22s stays far under
// A first attempt batched 80 embed inputs in one call and blew the 10K TPM cap
// (fatal, no retry). Lesson: throttle + retry, don't batch, on free tier.
const INTER_PAPER_DELAY_MS = 22_000;
const AGENT_REVIEW_DELAY_MS = 8_000; // Sonnet is a separate bucket; space it too
const RETRY_BACKOFF_MS = [25_000, 60_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a call on HTTP 429 with fixed backoff; rethrow anything else. */
async function retry429<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!String(e).includes('429')) throw e;
      if (attempt < RETRY_BACKOFF_MS.length) {
        const waitMs = RETRY_BACKOFF_MS[attempt];
        log.warn(label, `429 rate limited; retrying in ${waitMs / 1000}s`, { attempt: attempt + 1 });
        await sleep(waitMs);
      }
    }
  }
  throw lastErr;
}

// ── Curation plan ─────────────────────────────────────────────────────────────
// Each spec is a topic bucket we want to strengthen. `terms` are TITLE_ABS
// phrases OR'd together; `evidence` picks the study-type filter; `budget` is
// how many candidates to fetch (most-cited first). We over-provision slightly
// vs the ~40-50 target because dedupe (against the 38 live + 59 pending rows)
// and the relevance/plagiarism guards drop some.
//
// Weighting favors the GAPS: diet/nutrition, sleep, and cardio/conditioning
// are thin in the KB today; hypertrophy/strength already have ~30 entries, so
// we only top them up with a few landmark reviews (dedupe skips ones we have).
interface CurationSpec {
  label: string;
  bucket: 'diet' | 'sleep' | 'cardio' | 'strength_hypertrophy' | 'recovery';
  terms: string[];
  evidence: 'high' | 'mid'; // high = meta/systematic only; mid = also RCTs
  budget: number;
}

const CURATION_PLAN: CurationSpec[] = [
  // ── DIET / NUTRITION ──────────────────────────────────────────────────────
  {
    label: 'protein-for-muscle-strength',
    bucket: 'diet',
    terms: ['protein supplementation', 'protein intake', 'dietary protein', 'higher protein'],
    evidence: 'high',
    budget: 8,
  },
  {
    label: 'energy-deficit-body-composition',
    bucket: 'diet',
    terms: ['energy restriction', 'caloric restriction', 'caloric deficit', 'weight loss', 'hypocaloric'],
    evidence: 'high',
    budget: 6,
  },
  {
    label: 'creatine-supplementation',
    bucket: 'diet',
    terms: ['creatine supplementation', 'creatine monohydrate'],
    evidence: 'high',
    budget: 5,
  },
  {
    label: 'nutrient-timing-protein-distribution',
    bucket: 'diet',
    terms: ['protein timing', 'nutrient timing', 'protein distribution', 'pre-sleep protein', 'meal frequency'],
    evidence: 'mid',
    budget: 4,
  },
  // ── SLEEP ───────────────────────────────────────────────────────────────────
  {
    label: 'sleep-and-performance',
    bucket: 'sleep',
    terms: ['sleep', 'sleep extension', 'sleep deprivation', 'sleep restriction'],
    evidence: 'mid',
    budget: 7,
  },
  {
    label: 'sleep-recovery-muscle',
    bucket: 'sleep',
    terms: ['sleep quality', 'sleep hygiene', 'napping'],
    evidence: 'mid',
    budget: 5,
  },
  // ── CARDIO / CONDITIONING ────────────────────────────────────────────────────
  {
    label: 'hiit-vs-continuous',
    bucket: 'cardio',
    terms: ['high-intensity interval training', 'sprint interval training', 'interval training'],
    evidence: 'high',
    budget: 7,
  },
  {
    label: 'concurrent-training-interference',
    bucket: 'cardio',
    terms: ['concurrent training', 'interference effect', 'concurrent strength endurance'],
    evidence: 'high',
    budget: 4,
  },
  // (No standalone aerobic-adaptations spec: VO2max/endurance metas are already
  // covered by the HIIT-vs-continuous spec, and a broader aerobic query only
  // surfaced disease-endpoint epidemiology — net junk.)
  // ── STRENGTH / HYPERTROPHY (landmark top-ups only; dedupe drops what we have) ─
  {
    label: 'volume-dose-response',
    bucket: 'strength_hypertrophy',
    terms: ['training volume', 'set volume', 'weekly sets', 'dose-response resistance'],
    evidence: 'high',
    budget: 4,
  },
  {
    label: 'proximity-to-failure',
    bucket: 'strength_hypertrophy',
    terms: ['training to failure', 'repetitions in reserve', 'proximity to failure'],
    evidence: 'high',
    budget: 4,
  },
];

// Domain anchor: every candidate must ALSO match one of these in title/abstract,
// so a bare topic keyword (e.g. "weight loss", "sleep") can't drag in a clinical
// paper that has nothing to do with training. This is what keeps "no junk" — the
// preview without it surfaced frailty/DASH-diet/mitochondrial-disorder megapapers.
const DOMAIN_ANCHORS: Record<CurationSpec['bucket'], string> = {
  diet:
    '(TITLE_ABS:"resistance training" OR TITLE_ABS:"resistance exercise" OR TITLE_ABS:"strength training" OR TITLE_ABS:"muscle mass" OR TITLE_ABS:"lean mass" OR TITLE_ABS:"fat-free mass" OR TITLE_ABS:"muscle strength" OR TITLE_ABS:"hypertrophy" OR TITLE_ABS:"body composition" OR TITLE_ABS:"athletes")',
  // Sleep is the hardest bucket to keep clean — clinical sleep medicine
  // dominates the corpus. Require a SPORT/PERFORMANCE/TRAINING context
  // explicitly; do NOT allow bare "muscle"/"strength"/"exercise" (those
  // leak in sarcopenia, insomnia-CBT, sleep-apnea, low-back-pain reviews).
  sleep:
    '(TITLE_ABS:"athletes" OR TITLE_ABS:"athletic performance" OR TITLE_ABS:"exercise performance" OR TITLE_ABS:"physical performance" OR TITLE_ABS:"sports performance" OR TITLE_ABS:"resistance training" OR TITLE_ABS:"strength training")',
  cardio:
    '(TITLE_ABS:"VO2max" OR TITLE_ABS:"VO2 max" OR TITLE_ABS:"VO2peak" OR TITLE_ABS:"cardiorespiratory fitness" OR TITLE_ABS:"aerobic" OR TITLE_ABS:"endurance" OR TITLE_ABS:"interval training" OR TITLE_ABS:"exercise training" OR TITLE_ABS:"physical fitness")',
  strength_hypertrophy:
    '(TITLE_ABS:"resistance training" OR TITLE_ABS:"resistance exercise" OR TITLE_ABS:"strength training" OR TITLE_ABS:"hypertrophy" OR TITLE_ABS:"muscle")',
  recovery:
    '(TITLE_ABS:"resistance training" OR TITLE_ABS:"muscle" OR TITLE_ABS:"exercise" OR TITLE_ABS:"athletes")',
};

// Hard exclusions: papers that are PRIMARILY about a clinical disease have no
// place in a gym KB even if they mention "resistance training" as one arm.
// Deliberately NARROW — we keep diabetes / hypertension / obesity / older
// adults / sarcopenia, since cardiometabolic and muscle-preservation findings
// are relevant to our users. Only clearly-off-domain disease contexts here.
const EXCLUDE_OFF_DOMAIN =
  'NOT (TITLE_ABS:"cancer" OR TITLE_ABS:"oncology" OR TITLE_ABS:"mitochondrial disease" OR TITLE_ABS:"schizophrenia" OR TITLE_ABS:"bipolar" OR TITLE_ABS:"major depressive" OR TITLE_ABS:"stroke" OR TITLE_ABS:"dementia" OR TITLE_ABS:"Alzheimer" OR TITLE_ABS:"Parkinson" OR TITLE_ABS:"multiple sclerosis" OR TITLE_ABS:"cystic fibrosis" OR TITLE_ABS:"non-alcoholic fatty liver" OR TITLE_ABS:"colorectal" OR TITLE_ABS:"chronic kidney" OR TITLE_ABS:"COPD" OR TITLE_ABS:"fibromyalgia" OR TITLE_ABS:"chronic fatigue" OR TITLE_ABS:"restless legs" OR TITLE_ABS:"post-traumatic stress" OR TITLE_ABS:"concussion" OR TITLE_ABS:"sleep apnea" OR TITLE_ABS:"spinal cord" OR TITLE_ABS:"cerebral palsy" OR TITLE_ABS:"rheumatoid")';

// ── Europe PMC fetch (own query path; no recency clamp, most-cited first) ──────
// We don't reuse europepmcSource.fetch because that one date-windows from the
// cron checkpoint (2024+), which would hide the landmark older meta-analyses
// we're specifically after. Same endpoint + same `resultType=core` mapping.
const EPMC_ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const EPMC_PAGE_SIZE = 25;

interface EpmcResult {
  id: string;
  source: string;
  pmid?: string;
  doi?: string;
  title: string;
  authorString?: string;
  authorList?: { author?: Array<{ fullName?: string }> };
  journalTitle?: string;
  pubYear?: string;
  firstPublicationDate?: string;
  abstractText?: string;
  pubTypeList?: { pubType?: string[] };
  citedByCount?: number;
  isOpenAccess?: 'Y' | 'N';
  license?: string;
}

function authorsFrom(r: EpmcResult): string[] {
  const list = r.authorList?.author ?? [];
  if (list.length > 0) return list.map((a) => a.fullName ?? '').filter(Boolean);
  if (r.authorString) return r.authorString.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function urlFrom(r: EpmcResult): string {
  if (r.doi) return `https://doi.org/${r.doi}`;
  if (r.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
  return `https://europepmc.org/abstract/${r.source}/${r.id}`;
}

function toPaper(r: EpmcResult): Paper | null {
  if (!r.abstractText || r.abstractText.length < 100) return null; // can't distill
  if (!r.title) return null;
  return {
    source: 'europe_pmc',
    url: urlFrom(r),
    title: r.title,
    abstract: r.abstractText,
    authors: authorsFrom(r),
    journal: r.journalTitle,
    pub_year: r.pubYear ? Number(r.pubYear) : undefined,
    pub_date: r.firstPublicationDate || undefined,
    identifier: r.pmid ?? r.doi ?? r.id,
    source_meta: {
      epmc_id: r.id,
      epmc_source: r.source,
      pmid: r.pmid,
      doi: r.doi,
      cited_by_count: typeof r.citedByCount === 'number' ? r.citedByCount : undefined,
      pub_types: r.pubTypeList?.pubType ?? undefined,
      is_open_access: r.isOpenAccess === 'Y',
      license: r.license,
    },
    license: r.isOpenAccess === 'Y' ? (r.license ?? 'OA') : 'abstract-only',
  };
}

function buildQuery(spec: CurationSpec): string {
  const today = new Date().toISOString().slice(0, 10);
  const phrases = spec.terms.map((t) => `TITLE_ABS:"${t}"`).join(' OR ');
  // Evidence gate: PUB_TYPE catches MEDLINE-indexed designs; the TITLE phrase
  // OR is a robustness net for records whose pub-type indexing is incomplete.
  const evidence = spec.evidence === 'high'
    ? '(PUB_TYPE:"Meta-Analysis" OR PUB_TYPE:"systematic review" OR TITLE:"meta-analysis" OR TITLE:"systematic review")'
    : '(PUB_TYPE:"Meta-Analysis" OR PUB_TYPE:"systematic review" OR PUB_TYPE:"Randomized Controlled Trial" OR TITLE:"meta-analysis" OR TITLE:"systematic review" OR TITLE:"randomized")';
  return [
    `(${phrases})`,
    DOMAIN_ANCHORS[spec.bucket], // must also be exercise-science — kills clinical junk
    EXCLUDE_OFF_DOMAIN,          // and must NOT be primarily a disease paper
    evidence,
    'LANG:eng',
    '(SRC:MED OR SRC:PMC)',
    `FIRST_PDATE:[2010-01-01 TO ${today}]`,
  ].join(' AND ');
}

async function fetchSpec(spec: CurationSpec): Promise<Paper[]> {
  const query = buildQuery(spec);
  const papers: Paper[] = [];
  const seen = new Set<string>();
  let cursor = '*';
  let pageCount = 0;
  const MAX_PAGES = 6;

  while (papers.length < spec.budget && pageCount < MAX_PAGES) {
    const params = new URLSearchParams({
      query,
      format: 'json',
      resultType: 'core',
      pageSize: String(EPMC_PAGE_SIZE),
      cursorMark: cursor,
      sort: 'CITED desc', // most-cited first → landmark papers surface
    });
    if (PUBMED_CONTACT_EMAIL) params.set('email', PUBMED_CONTACT_EMAIL);

    const res = await fetch(`${EPMC_ENDPOINT}?${params.toString()}`);
    if (!res.ok) {
      log.warn('curated', `Europe PMC ${res.status} for "${spec.label}"`, { body: (await res.text()).slice(0, 200) });
      break;
    }
    const body = await res.json();
    const results: EpmcResult[] = body?.resultList?.result ?? [];
    if (results.length === 0) break;

    for (const r of results) {
      const p = toPaper(r);
      if (!p) continue;
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      p.source_meta = { ...(p.source_meta ?? {}), ingest_bucket: spec.bucket, ingest_topic: spec.label };
      papers.push(p);
      if (papers.length >= spec.budget) break;
    }

    const next = body?.nextCursorMark ?? null;
    if (!next || next === cursor) break;
    cursor = next;
    pageCount += 1;
  }
  return papers;
}

// ── Small concurrency pool ─────────────────────────────────────────────────────
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
interface CliOpts { dryRun: boolean; fetchOnly: boolean; noReview: boolean; only: string | null; max: number | null; }
function parseArgs(): CliOpts {
  const o: CliOpts = { dryRun: false, fetchOnly: false, noReview: false, only: null, max: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--fetch-only') o.fetchOnly = true;
    else if (a === '--no-review') o.noReview = true;
    else if (a.startsWith('--only=')) o.only = a.slice('--only='.length);
    else if (a.startsWith('--max=')) o.max = Number(a.slice('--max='.length));
    else if (a === '--help' || a === '-h') {
      console.log('Usage: tsx curated.ts [--fetch-only] [--dry-run] [--no-review] [--only=<label>] [--max=N]');
      process.exit(0);
    } else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  return o;
}

// Build the agent-review input shape from the pieces we already computed.
function toAgentInput(
  pendingId: string,
  paper: Paper,
  dist: Distillation,
  trust: number,
  flags: ContradictionFlag[],
  authority: Awaited<ReturnType<typeof enrichAuthority>>,
): PendingPaperForAgent {
  return {
    pending_id: pendingId,
    title: paper.title,
    url: paper.url,
    source: paper.source,
    authors: paper.authors,
    journal: paper.journal ?? null,
    pub_year: paper.pub_year ?? null,
    topic_tags: dist.topic_tags,
    trust_score: trust,
    study_design: dist.study_design,
    confidence: dist.confidence,
    license: paper.license ?? null,
    population: dist.population,
    intervention: dist.intervention,
    key_finding: dist.key_finding,
    practical_takeaway: dist.practical_takeaway,
    ingested_at: new Date().toISOString(),
    contradiction_flags: flags,
    authority: {
      author_h_index: authority.authorMaxHIndex,
      citation_count: authority.citationCount,
      influential_citations: authority.influentialCitationCount,
      journal_tier: authority.journalTier,
      source: authority.source,
    },
  };
}

async function main() {
  const opts = parseArgs();
  // fetch-only hits only the Europe PMC network — no keys needed. Both dry-run
  // and live distill (Anthropic) AND embed (Voyage), so both need the full set.
  if (!opts.fetchOnly) assertRequiredEnv();

  let plan = CURATION_PLAN;
  if (opts.only) plan = plan.filter((s) => s.label.includes(opts.only!) || s.bucket.includes(opts.only!));
  log.info('curated', 'config', {
    mode: opts.fetchOnly ? 'fetch-only' : opts.dryRun ? 'dry-run' : 'live',
    review: !opts.noReview && !opts.dryRun && !opts.fetchOnly,
    specs: plan.map((s) => `${s.label}(${s.budget})`),
    max: opts.max,
  });

  // ── 1. Fetch candidates ────────────────────────────────────────────────────
  let candidates: Paper[] = [];
  for (const spec of plan) {
    const got = await fetchSpec(spec);
    log.info('curated', `fetched ${got.length} for "${spec.label}"`, { bucket: spec.bucket });
    candidates.push(...got);
  }
  // Cross-spec URL dedupe (a paper can match two topic queries).
  const seenUrl = new Set<string>();
  candidates = candidates.filter((p) => (seenUrl.has(p.url) ? false : (seenUrl.add(p.url), true)));
  if (opts.max && candidates.length > opts.max) candidates = candidates.slice(0, opts.max);
  log.info('curated', `${candidates.length} unique candidates after cross-spec dedupe`);

  // ── 2. Relevance filter (local, no DB) ──────────────────────────────────────
  const relevantCandidates = candidates.filter((p) => isRelevant(p.title, p.abstract));
  log.info('curated', `${relevantCandidates.length} pass relevance (dropped ${candidates.length - relevantCandidates.length})`);

  // ── 2b. Fetch-only preview ──────────────────────────────────────────────────
  // Bail out BEFORE creating the service client or touching the DB so the
  // advertised preview mode runs in a fresh/local env with no Supabase creds.
  if (opts.fetchOnly) {
    console.log('\n── Candidate preview (fetch-only) ──');
    for (const p of relevantCandidates) {
      const m = (p.source_meta ?? {}) as Record<string, unknown>;
      console.log(`• [${m.ingest_bucket}/${m.ingest_topic}] ${p.pub_year ?? '????'} — ${p.title}`);
      console.log(`    ${p.journal ?? 'unknown journal'} · cited ${m.cited_by_count ?? '?'} · ${p.url}`);
    }
    console.log(`\n${relevantCandidates.length} candidates would proceed to distillation.`);
    process.exit(0);
  }

  const client = makeServiceClient();

  // ── 3. DB dedupe (skip anything already in kb or pending) ───────────────────
  const dedupeFlags = await mapPool(relevantCandidates, 5, (p) => isAlreadyIngested(client, p.url));
  const relevant = relevantCandidates.filter((_, i) => !dedupeFlags[i]);
  log.info('curated', `${relevant.length} fresh (skipped ${relevantCandidates.length - relevant.length} already in kb/pending)`);

  if (relevant.length === 0) { log.info('curated', 'nothing to process'); process.exit(0); }

  // ── 4-10. Sequential, throttled pipeline ────────────────────────────────────
  // One paper at a time with a fixed inter-paper delay so free-tier Voyage
  // (3 RPM / 10K TPM) and Anthropic tier-1 (50K ITPM) are never exceeded.
  // Every external call is also 429-retry-wrapped as a second line of defense.
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const landed: Array<{ pendingId: string; input: PendingPaperForAgent }> = [];

  log.info('curated', `processing ${relevant.length} papers sequentially (~${INTER_PAPER_DELAY_MS / 1000}s/paper for free-tier limits)`);

  for (let i = 0; i < relevant.length; i++) {
    const paper = relevant[i];
    // Throttle between papers — dry-run now also runs the Voyage/Semantic
    // Scholar scoring + safety stages, so it needs the same inter-paper spacing.
    if (i > 0) await sleep(INTER_PAPER_DELAY_MS);

    // Distill (Haiku) — structured fields + topic tags.
    let dist: Distillation;
    try {
      dist = await retry429('distill', () => distill(paper));
    } catch (e) {
      log.reject('curated', 'distill-failed', { url: paper.url, error: String(e).slice(0, 160) });
      bump('rejected_distillation');
      continue;
    }

    // Embed HyDE passage + abstract in one small Voyage call (2 inputs ≈ ~750
    // tokens, well under the 10K TPM cap), 429-retried.
    let hydeEmb: number[];
    let abstractEmb: number[];
    try {
      const passage = buildHydePassage(paper, dist);
      [hydeEmb, abstractEmb] = await retry429('voyage', () => embedDocumentsBatch([passage, paper.abstract]));
    } catch (e) {
      log.reject('curated', 'embedding-failed', { url: paper.url, error: String(e).slice(0, 160) });
      bump('rejected_embedding');
      continue;
    }

    // Plagiarism guard.
    const sim = cosineSimilarity(hydeEmb, abstractEmb);
    if (sim > PLAGIARISM_THRESHOLD) {
      log.reject('curated', 'plagiarism-guard', { url: paper.url, sim: sim.toFixed(3) });
      bump('rejected_plagiarism');
      continue;
    }

    // Trust v2 (Semantic Scholar best-effort; falls back gracefully on 429).
    const authority = await enrichAuthority(paper);
    const trust = trustScoreV2(dist, authority);
    paper.source_meta = {
      ...(paper.source_meta ?? {}),
      authority: {
        author_h_index: authority.authorMaxHIndex,
        citation_count: authority.citationCount,
        influential_citations: authority.influentialCitationCount,
        journal_tier: authority.journalTier,
        source: authority.source,
      },
    };

    // Contradiction detection (reuses the HyDE embedding; best-effort).
    let flags: ContradictionFlag[] = [];
    try { flags = await findConflicts(client, paper, dist, hydeEmb); }
    catch (e) { log.warn('curated', 'findConflicts threw; continuing', { url: paper.url, error: String(e).slice(0, 160) }); }

    // Dry-run stops here: every distill + score + safety stage above has run
    // (so the no-write mode actually exercises the live pipeline), but we skip
    // the pending insert and the downstream advisory review.
    if (opts.dryRun) {
      log.info('curated', '[DRY] would land (scored, not written)', {
        title: paper.title.slice(0, 90),
        study_design: dist.study_design,
        tags: dist.topic_tags,
        trust,
        plagiarism_sim: sim.toFixed(3),
        contradiction_flags: flags.length,
      });
      bump('would_add');
      continue;
    }

    // Land in pending.
    let pendingId: string;
    try {
      pendingId = await insertPending(client, paper, dist, hydeEmb, trust, flags.length > 0 ? flags : null);
    } catch (e) {
      log.error('curated', 'insertPending failed', { url: paper.url, error: String(e).slice(0, 200) });
      bump('error');
      continue;
    }
    log.add('curated', paper.title.slice(0, 80), { url: paper.url, pending_id: pendingId, trust });
    bump('added');
    landed.push({ pendingId, input: toAgentInput(pendingId, paper, dist, trust, flags, authority) });
  }

  // ── 11. Advisory agent review — sequential + throttled, write but DO NOT apply ──
  if (!opts.dryRun && !opts.noReview && landed.length > 0) {
    log.info('curated', `advisory agent review on ${landed.length} paper(s) (Sonnet, sequential; no auto-apply)`);
    let add = 0, skip = 0, failed = 0;
    for (let i = 0; i < landed.length; i++) {
      if (i > 0) await sleep(AGENT_REVIEW_DELAY_MS);
      const { pendingId, input } = landed[i];
      try {
        const d = await retry429('agent-review', () => runAgentReview(input));
        const verdict = d.final_action === 'reject' ? 'skip' : 'add';
        if (verdict === 'add') add++; else skip++;
        const recommendation = {
          verdict,
          action: d.final_action,
          proposed_action: d.proposed_action,
          confidence: d.confidence,
          rationale: d.rationale,
          flags: d.flags,
          downgrade_reason: d.downgrade_reason,
          superseded_kb_ids: d.superseded_kb_ids,
          model: 'claude-sonnet-4-20250514',
          reviewed_at: new Date().toISOString(),
        };
        const { error } = await client.from('research_kb_pending').update({ agent_recommendation: recommendation }).eq('id', pendingId);
        if (error) { log.warn('curated', 'agent_recommendation update failed', { pendingId, error: error.message }); failed++; }
        else log.info('curated', `agent: ${verdict.toUpperCase()} (${d.confidence.toFixed(2)})`, { pendingId, action: d.final_action });
      } catch (e) {
        log.warn('curated', 'runAgentReview threw', { pendingId, error: String(e).slice(0, 160) }); failed++;
      }
    }
    log.info('curated', 'advisory review done', { agent_add: add, agent_skip: skip, failed });
  }

  log.info('curated', 'done', { ...counts, landed: landed.length, dry_run: opts.dryRun });
  process.exit(0);
}

main().catch((err) => { log.error('curated', 'fatal', { error: String(err) }); process.exit(1); });
