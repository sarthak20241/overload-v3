/**
 * Research ingestion orchestrator (Phase 3).
 *
 * Run nightly from GitHub Actions (`0 3 * * *` UTC) or manually for testing:
 *
 *   npx tsx tools/research-ingest/run.ts                    # default: all sources, 20 papers each
 *   npx tsx tools/research-ingest/run.ts --dry-run          # no DB writes
 *   npx tsx tools/research-ingest/run.ts --max-papers=5     # tiny smoke run
 *   npx tsx tools/research-ingest/run.ts --source=europe_pmc
 *
 * Pipeline per paper:
 *   dedupe → denylist → relevance filter → Haiku distill →
 *   plagiarism guard → Voyage embed (HyDE) → insert into research_kb_pending
 *
 * Exits 0 if at least the cron made progress (even partial). Exits 1 only if
 * every source threw before fetching any papers — that's a true outage.
 */
import './shared/env.js';
import { assertRequiredEnv } from './shared/env.js';
import { log } from './shared/log.js';
import { distill } from './shared/anthropic.js';
import { embedDocumentsBatch, cosineSimilarity } from './shared/voyage.js';
import { isRelevant, relevanceMatch } from './shared/relevance.js';
import { buildHydePassage } from './shared/hyde.js';
import {
  makeServiceClient,
  getCheckpoint,
  updateCheckpoint,
  loadDenylist,
  isDenied,
  isAlreadyIngested,
  insertPending,
} from './shared/supabase.js';
import type { IngestResult, Source, Paper } from './shared/types.js';

import { europepmcSource } from './sources/europepmc.js';
import { buildTopicPlan, type TopicPlan, type TopicPlanItem } from './shared/topics.js';

const ALL_SOURCES: Source[] = [europepmcSource];

// For now every topic-plan item routes to Europe PMC. When bioRxiv +
// SportRxiv land we'll branch by bucket / topic content (e.g. preprints
// for "trending", established journals for "user_need"). Map is a single
// function so adding sources is a localized change.
function pickSourceFor(_item: TopicPlanItem): Source {
  return europepmcSource;
}

// Plagiarism threshold: cos(HyDE_passage, source_abstract). The HyDE passage
// is BY DESIGN derived from the abstract via Haiku — a *faithful* distillation
// will naturally score 0.80-0.92 (it covers the same semantic content with
// different framing + added HyDE questions). Literal copy-paste shows up at
// 0.95+. We start at 0.93 — that catches near-verbatim Haiku output without
// false-positive-rejecting honest summaries. Empirical tuning via the audit
// log once we have ~50 ingestions.
const PLAGIARISM_THRESHOLD = 0.93;
const DEFAULT_MAX_PAPERS = 20;

// Free-tier Voyage caps at 3 RPM. With one batched call per paper that's a
// hard 20s/paper floor. We add a small inter-paper delay so smoke tests on
// the free tier don't hit 429 on every 3rd paper, and 429-aware retry so
// when we do hit one, we recover instead of dropping the paper.
const INTER_PAPER_DELAY_MS = 22_000; // > 20s = stays under 3 RPM
const RETRY_BACKOFF_MS = [25_000, 60_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedWithRetry(inputs: string[]): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await embedDocumentsBatch(inputs);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      // Only retry on 429. Anything else (auth, malformed, etc.) is fatal.
      if (!msg.includes('429')) throw e;
      if (attempt < RETRY_BACKOFF_MS.length) {
        const waitMs = RETRY_BACKOFF_MS[attempt];
        log.warn('voyage', `429 rate limited; retrying in ${waitMs / 1000}s`, { attempt: attempt + 1 });
        await sleep(waitMs);
      }
    }
  }
  throw lastErr;
}

// ── CLI args ────────────────────────────────────────────────────────────────
interface CliOpts {
  dryRun: boolean;
  maxPapers: number;
  sourceFilter: string | null;
  // Skip the topic-driven planning pass and use the source's default broad
  // query. Useful for debugging the fetch path without burning a Haiku
  // clustering call, or for cold-start runs where coach_traces is empty.
  skipTopicPlan: boolean;
}

function parseArgs(): CliOpts {
  const opts: CliOpts = {
    dryRun: false,
    maxPapers: DEFAULT_MAX_PAPERS,
    sourceFilter: null,
    skipTopicPlan: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--max-papers=')) opts.maxPapers = Number(arg.slice('--max-papers='.length));
    else if (arg.startsWith('--source=')) opts.sourceFilter = arg.slice('--source='.length);
    else if (arg === '--skip-topic-plan') opts.skipTopicPlan = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx run.ts [--dry-run] [--max-papers=N] [--source=NAME] [--skip-topic-plan]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// ── Trust scoring stub ──────────────────────────────────────────────────────
// Real trust scoring (Semantic Scholar h-index + journal tier + study design)
// lands in a follow-up commit. For v1 we use a study-design heuristic only —
// enough signal to outrank single observational studies vs. meta-analyses.
function trustScoreV1(studyDesign: string, confidence: string): number {
  let s = 0.5;
  if (studyDesign === 'meta-analysis' || studyDesign === 'systematic-review') s = 0.85;
  else if (studyDesign === 'RCT') s = 0.7;
  else if (studyDesign === 'crossover') s = 0.65;
  else if (studyDesign === 'cohort') s = 0.55;
  else if (studyDesign === 'observational') s = 0.45;
  else if (studyDesign === 'narrative-review') s = 0.5;
  else if (studyDesign === 'preprint') s = 0.4;
  if (confidence === 'replicated') s = Math.min(0.95, s + 0.05);
  if (confidence === 'preliminary') s = Math.max(0.3, s - 0.1);
  return Math.round(s * 100) / 100;
}

// ── Per-paper pipeline ──────────────────────────────────────────────────────
async function processPaper(
  client: ReturnType<typeof makeServiceClient>,
  paper: Paper,
  denylist: string[],
  opts: CliOpts,
): Promise<IngestResult> {
  try {
    if (await isAlreadyIngested(client, paper.url)) {
      return { paper, status: 'skipped_duplicate' };
    }
    const denyMatch = isDenied(paper.url, denylist);
    if (denyMatch) {
      return { paper, status: 'skipped_denylist', reason: denyMatch };
    }
    if (!isRelevant(paper.title, paper.abstract)) {
      return { paper, status: 'skipped_irrelevant' };
    }

    let dist;
    try {
      dist = await distill(paper);
    } catch (e) {
      return { paper, status: 'rejected_distillation', reason: String(e) };
    }

    // Plagiarism guard: embed the HyDE passage + the source abstract in ONE
    // batched Voyage call, then compute cosine similarity. If they're too
    // similar, Haiku just paraphrased the abstract instead of synthesizing.
    // Batching halves API calls per paper — important under Voyage's free-
    // tier rate limit (3 RPM until a payment method is on file).
    let embedding: number[];
    try {
      const passage = buildHydePassage(paper, dist);
      const [hydeEmb, abstractEmb] = await embedWithRetry([passage, paper.abstract]);
      embedding = hydeEmb;
      const sim = cosineSimilarity(hydeEmb, abstractEmb);
      if (sim > PLAGIARISM_THRESHOLD) {
        return {
          paper,
          status: 'rejected_plagiarism',
          reason: `cos(distillation, abstract)=${sim.toFixed(3)} > ${PLAGIARISM_THRESHOLD}`,
        };
      }
    } catch (e) {
      return { paper, status: 'rejected_embedding', reason: String(e) };
    }

    const trust = trustScoreV1(dist.study_design, dist.confidence);

    if (opts.dryRun) {
      log.info('orch', '[DRY] would insert', {
        url: paper.url,
        title: paper.title,
        study_design: dist.study_design,
        topic_tags: dist.topic_tags,
        trust,
        hyde: dist.hyde_questions,
      });
      return { paper, status: 'added' };
    }

    const pendingId = await insertPending(client, paper, dist, embedding, trust);
    return { paper, status: 'added', pending_id: pendingId };
  } catch (e) {
    return { paper, status: 'error', reason: String(e) };
  }
}

// ── Topic-item runner ───────────────────────────────────────────────────────
// Replaces the old runSource. Each topic-plan item runs through here: the
// source is given the item's queryTerms + budget, then each returned paper
// is tagged with the bucket/label before going through processPaper. That
// way the dashboard can show "imported as gap-fill for 'deload timing'"
// alongside every paper.
interface TopicItemResult {
  fetched: number;
  added: number;
  lastIdentifier: string | null;
  lastPubDate: string | null;
  error: string | null;
  counts: Record<string, number>;
  /** Track URLs we ran the pipeline on across topics so a paper showing up
   *  in multiple topic queries (overlap is fine) doesn't double-spend
   *  Haiku. The orchestrator threads a shared Set across all topic runs. */
}

async function runTopicItem(
  client: ReturnType<typeof makeServiceClient>,
  source: Source,
  item: TopicPlanItem,
  denylist: string[],
  opts: CliOpts,
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  seenUrls: Set<string>,
  voyageCallsSoFar: { count: number },
): Promise<TopicItemResult> {
  const tag = `${source.name}/${item.bucket}/${item.label}`;
  log.info(tag, 'starting', {
    budget: item.budget,
    query_terms: item.queryTerms.length > 0 ? item.queryTerms : '(default broad query)',
  });

  let papers: Paper[] = [];
  try {
    papers = await source.fetch(checkpoint, {
      maxPapers: item.budget,
      queryTerms: item.queryTerms.length > 0 ? item.queryTerms : undefined,
    });
  } catch (e) {
    log.error(tag, 'fetch failed', { error: String(e) });
    return { fetched: 0, added: 0, lastIdentifier: null, lastPubDate: null, error: String(e), counts: {} };
  }

  // Cross-topic dedupe: if topic A already returned this paper, topic B's
  // copy of it is skipped here (cheaper than calling isAlreadyIngested
  // which hits Postgres). The DB-level dedupe still runs as a safety net
  // inside processPaper.
  papers = papers.filter((p) => {
    if (seenUrls.has(p.url)) return false;
    seenUrls.add(p.url);
    return true;
  });
  log.info(tag, `fetched ${papers.length} unique candidate papers (after cross-topic dedupe)`);

  // Tag each paper with its bucket / topic label for audit + dashboard.
  // Stored in source_meta as ingest_bucket + ingest_topic.
  for (const p of papers) {
    p.source_meta = {
      ...(p.source_meta ?? {}),
      ingest_bucket: item.bucket,
      ingest_topic: item.label,
    };
  }

  let added = 0;
  let lastIdentifier: string | null = checkpoint.last_identifier;
  let lastPubDate: string | null = checkpoint.last_pub_date;
  const counts: Record<string, number> = {};

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    // Throttle against Voyage's 3 RPM free-tier cap. Counter is shared
    // across topic items so a multi-topic run still stays under the cap.
    if (voyageCallsSoFar.count > 0) {
      await sleep(INTER_PAPER_DELAY_MS);
    }
    const result = await processPaper(client, paper, denylist, opts);
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    // We count any paper that reached the embedding step (plagiarism + add)
    // as a Voyage call. The earlier filter rejects (duplicate, denylist,
    // irrelevant, distillation-failed) bypass Voyage so they don't count.
    if (
      result.status === 'added' ||
      result.status === 'rejected_plagiarism' ||
      result.status === 'rejected_embedding'
    ) {
      voyageCallsSoFar.count += 1;
    }

    if (result.status === 'added') {
      added += 1;
      log.add(tag, paper.title.slice(0, 80), {
        url: paper.url,
        pending_id: result.pending_id,
      });
    } else if (result.status === 'skipped_duplicate') {
      log.skip(tag, 'duplicate', { url: paper.url });
    } else if (result.status === 'skipped_denylist') {
      log.skip(tag, 'denylist', { url: paper.url, match: result.reason });
    } else if (result.status === 'skipped_irrelevant') {
      log.skip(tag, 'irrelevant', { url: paper.url, title: paper.title.slice(0, 60) });
    } else if (result.status === 'rejected_plagiarism') {
      log.reject(tag, 'plagiarism-guard', { url: paper.url, reason: result.reason });
    } else if (result.status === 'rejected_distillation') {
      log.reject(tag, 'distillation-failed', { url: paper.url, reason: result.reason });
    } else if (result.status === 'rejected_embedding') {
      log.reject(tag, 'embedding-failed', { url: paper.url, reason: result.reason });
    } else {
      log.error(tag, 'pipeline-error', { url: paper.url, reason: result.reason });
    }

    // Track high-water marks. Papers come oldest-first, so the last one
    // processed is the newest.
    if (paper.pub_date) lastPubDate = paper.pub_date.slice(0, 10);
    if (paper.identifier) lastIdentifier = paper.identifier;
  }

  log.info(tag, 'summary', { ...counts, total: papers.length });
  return { fetched: papers.length, added, lastIdentifier, lastPubDate, error: null, counts };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  assertRequiredEnv();

  log.info('orch', 'config', {
    dry_run: opts.dryRun,
    total_papers_budget: opts.maxPapers,
    source_filter: opts.sourceFilter,
    skip_topic_plan: opts.skipTopicPlan,
  });

  const client = makeServiceClient();
  const denylist = await loadDenylist(client);
  log.info('orch', `loaded ${denylist.length} denylist patterns`);

  // ── Build the topic plan ────────────────────────────────────────────────
  // Three buckets per run, 40/40/20 split:
  //   user_need — top topics by user-question count (frequency-driven)
  //   gap       — top topics by question-count × (1 - retrieval strength)
  //   trending  — broad default query for fresh general research
  // --skip-topic-plan uses a single trending bucket only.
  let plan: TopicPlan;
  if (opts.skipTopicPlan) {
    plan = {
      items: [{
        bucket: 'trending',
        label: 'broad query (--skip-topic-plan)',
        queryTerms: [],
        budget: opts.maxPapers,
        rationale: 'topic plan skipped via CLI flag',
      }],
      totalBudget: opts.maxPapers,
      generatedAt: new Date().toISOString(),
      traceSampleSize: 0,
    };
  } else {
    try {
      plan = await buildTopicPlan(client, { totalBudget: opts.maxPapers });
    } catch (e) {
      // Plan construction shouldn't normally fail (buildTopicPlan has its own
      // fallback to trending-only), but a runtime bug would be fatal here
      // without this catch.
      log.error('orch', 'topic plan failed; falling back to trending-only', { error: String(e).slice(0, 200) });
      plan = {
        items: [{
          bucket: 'trending',
          label: 'broad query (plan failure fallback)',
          queryTerms: [],
          budget: opts.maxPapers,
          rationale: `plan failed: ${String(e).slice(0, 100)}`,
        }],
        totalBudget: opts.maxPapers,
        generatedAt: new Date().toISOString(),
        traceSampleSize: 0,
      };
    }
  }
  log.info('orch', `topic plan: ${plan.items.length} item(s), ${plan.traceSampleSize} trace sample`, {
    items: plan.items.map((it) => `[${it.bucket}] "${it.label}" budget=${it.budget}`),
  });

  // ── Iterate the plan ────────────────────────────────────────────────────
  // We only have one source (Europe PMC). When bioRxiv/SportRxiv land,
  // pickSourceFor decides per-item. Checkpoint is per-source so we
  // aggregate watermarks ACROSS topic items and update once at the end.
  // Cross-topic dedupe via seenUrls — same paper showing up in two topic
  // queries is processed once.
  const seenUrls = new Set<string>();
  const voyageCallsSoFar = { count: 0 };
  const aggregatedBySource = new Map<string, {
    fetched: number;
    added: number;
    lastIdentifier: string | null;
    lastPubDate: string | null;
    error: string | null;
  }>();
  let totalAdded = 0;
  let anySucceeded = false;

  for (const item of plan.items) {
    const source = pickSourceFor(item);
    if (opts.sourceFilter && source.name !== opts.sourceFilter) {
      log.skip('orch', `topic skipped by --source filter`, { topic: item.label, source: source.name });
      continue;
    }

    const checkpoint = await getCheckpoint(client, source.name);
    let r: Awaited<ReturnType<typeof runTopicItem>> | null = null;
    try {
      r = await runTopicItem(client, source, item, denylist, opts, checkpoint, seenUrls, voyageCallsSoFar);
      if (r.error === null) anySucceeded = true;
      totalAdded += r.added;
    } catch (e) {
      log.error('orch', `runTopicItem(${item.label}) threw`, { error: String(e).slice(0, 200) });
    }

    // Roll up source-level watermarks across all topic items.
    if (r) {
      const agg = aggregatedBySource.get(source.name) ?? {
        fetched: 0, added: 0, lastIdentifier: null, lastPubDate: null, error: null,
      };
      agg.fetched += r.fetched;
      agg.added += r.added;
      if (r.error) agg.error = r.error;
      // Watermarks: keep the highest seen. lastIdentifier is opaque/per-source
      // so we just keep the last non-null; lastPubDate is ISO date, so max
      // by string compare works.
      if (r.lastIdentifier) agg.lastIdentifier = r.lastIdentifier;
      if (r.lastPubDate && (!agg.lastPubDate || r.lastPubDate > agg.lastPubDate)) {
        agg.lastPubDate = r.lastPubDate;
      }
      aggregatedBySource.set(source.name, agg);
    }
  }

  // ── Advance source-level checkpoints ────────────────────────────────────
  if (!opts.dryRun) {
    for (const [sourceName, agg] of aggregatedBySource) {
      try {
        await updateCheckpoint(client, sourceName, {
          last_pub_date: agg.lastPubDate ?? undefined,
          last_identifier: agg.lastIdentifier ?? undefined,
          papers_fetched_delta: agg.fetched,
          papers_added_delta: agg.added,
          last_error: agg.error,
        });
      } catch (e) {
        log.error('orch', `updateCheckpoint(${sourceName}) failed; next run will re-fetch & dedupe`, {
          error: String(e).slice(0, 200),
        });
      }
    }
  }

  log.info('orch', 'done', {
    total_added: totalAdded,
    dry_run: opts.dryRun,
    topic_items_run: plan.items.length,
    voyage_calls: voyageCallsSoFar.count,
  });
  process.exit(anySucceeded ? 0 : 1);
}

main().catch((err) => {
  log.error('orch', 'fatal', { error: String(err) });
  process.exit(1);
});
