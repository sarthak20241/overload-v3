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
import { biorxivSource } from './sources/biorxiv.js';
import { sportrxivSource } from './sources/sportrxiv.js';
import { buildTopicPlan, type TopicPlan, type TopicPlanItem } from './shared/topics.js';
import { findConflicts, type ContradictionFlag } from './shared/contradictions.js';
import { enrichAuthority, trustScoreV2 } from './shared/trust.js';
import { runAgentReview, type PendingPaperForAgent, type AgentDecision } from './shared/agent-review.js';

const ALL_SOURCES: Source[] = [europepmcSource, biorxivSource, sportrxivSource];

/**
 * Map a topic-plan item to the set of sources it should hit, along with each
 * source's slice of the item's budget. Different buckets get different
 * source mixes:
 *
 *   user_need / gap → Europe PMC only. These buckets exist because USERS
 *     are asking about these topics; we want peer-reviewed evidence the
 *     coach can cite with confidence. Preprints would dilute trust here.
 *
 *   trending → fans out across all three sources, with weighting:
 *     Europe PMC gets the majority (latest peer-reviewed), bioRxiv gets
 *     a small share (catches bleeding-edge cross-domain preprints — most
 *     get filtered by the relevance keyword pass), SportRxiv gets a
 *     small share (all on-topic, but smaller corpus + OSF migration may
 *     mean low yield).
 *
 * The orchestrator iterates these returned (source, budget) pairs and
 * runs each as its own fetch, with cross-source dedupe via seenUrls.
 */
interface SourceShare {
  source: Source;
  budget: number;
}

function sourcesForItem(item: TopicPlanItem): SourceShare[] {
  if (item.bucket !== 'trending') {
    return [{ source: europepmcSource, budget: item.budget }];
  }
  // Trending: weighted fan-out. 60/20/20.
  const total = item.budget;
  const epmc = Math.max(1, Math.floor(total * 0.6));
  const biorxiv = Math.max(1, Math.floor(total * 0.2));
  const sportrxiv = Math.max(1, total - epmc - biorxiv);
  return [
    { source: europepmcSource, budget: epmc },
    { source: biorxivSource, budget: biorxiv },
    { source: sportrxivSource, budget: sportrxiv },
  ];
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
  // --review: skip ingestion entirely and run the auto-review agent pass.
  // The GH Actions cron invokes this AFTER the ingest pass — both share
  // the same binary so deploys are atomic.
  reviewMode: boolean;
  // For --review: minimum age (hours) of pending rows before the agent
  // acts. Default 24h gives the human the agreed-on window. Set to 0
  // for testing.
  reviewAgeHours: number;
}

function parseArgs(): CliOpts {
  const opts: CliOpts = {
    dryRun: false,
    maxPapers: DEFAULT_MAX_PAPERS,
    sourceFilter: null,
    skipTopicPlan: false,
    reviewMode: false,
    reviewAgeHours: 24,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--max-papers=')) opts.maxPapers = Number(arg.slice('--max-papers='.length));
    else if (arg.startsWith('--source=')) opts.sourceFilter = arg.slice('--source='.length);
    else if (arg === '--skip-topic-plan') opts.skipTopicPlan = true;
    else if (arg === '--review') opts.reviewMode = true;
    else if (arg.startsWith('--review-age-hours=')) opts.reviewAgeHours = Number(arg.slice('--review-age-hours='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx run.ts [--dry-run] [--max-papers=N] [--source=NAME] [--skip-topic-plan] [--review] [--review-age-hours=N]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// ── Trust scoring ────────────────────────────────────────────────────────────
// v2 lives in shared/trust.ts — combines study_design (base) with Semantic
// Scholar author h-index + citation count + journal tier from journals.ts.
// Imported below; the per-paper pipeline calls enrichAuthority() then
// trustScoreV2().
//

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

    // Trust scoring v2: study_design (base) + Semantic Scholar author
    // h-index + citation count + journal tier. enrichAuthority is best-
    // effort; if Semantic Scholar 404s or rate-limits we fall through to
    // a v1-equivalent score (study_design only). Authority enrichment is
    // also stashed into source_meta for the dashboard to display.
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

    // Contradiction detection (Phase 3). Reuses the HyDE embedding we just
    // computed — zero extra Voyage calls. 0–3 extra Haiku calls per paper,
    // and we never block on a verdict failure (worst case = paper lands
    // with `contradiction_flags=null`, same as if nothing conflicted).
    let contradictionFlags: ContradictionFlag[] = [];
    try {
      contradictionFlags = await findConflicts(client, paper, dist, embedding);
    } catch (e) {
      log.warn('contradictions', `findConflicts threw; continuing without flags`, {
        url: paper.url,
        error: String(e).slice(0, 200),
      });
    }

    if (opts.dryRun) {
      log.info('orch', '[DRY] would insert', {
        url: paper.url,
        title: paper.title,
        study_design: dist.study_design,
        topic_tags: dist.topic_tags,
        trust,
        hyde: dist.hyde_questions,
        contradictions: contradictionFlags.length,
        contradiction_verdicts: contradictionFlags.map((f) => `${f.verdict}@${f.similarity.toFixed(2)}`),
      });
      return { paper, status: 'added' };
    }

    const pendingId = await insertPending(
      client, paper, dist, embedding, trust,
      contradictionFlags.length > 0 ? contradictionFlags : null,
    );
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

// ── Auto-review pass ────────────────────────────────────────────────────────
// Triggered by --review. Walks every pending row >= reviewAgeHours old that
// doesn't yet have a live agent_review_log entry, calls the Sonnet agent,
// applies the (post-guardrail) action via existing RPCs, and logs the
// decision for audit + revert. Each paper costs ~1500 input + 500 output
// Sonnet tokens ≈ $0.012. At 20 papers/day worst-case = ~$0.24/day.
async function runAgentReviewPass(
  client: ReturnType<typeof makeServiceClient>,
  opts: CliOpts,
): Promise<void> {
  log.info('agent-review', 'starting', { age_hours: opts.reviewAgeHours, dry_run: opts.dryRun });

  // Pull pending rows ready for review.
  const { data: rows, error } = await client.rpc('pending_ready_for_agent_review', {
    p_age_hours: opts.reviewAgeHours,
    p_limit: 50,
  });
  if (error) {
    log.error('agent-review', `pending_ready_for_agent_review failed: ${error.message}`);
    return;
  }
  const pending = Array.isArray(rows) ? rows : [];
  if (pending.length === 0) {
    log.info('agent-review', 'no pending rows past the age threshold; nothing to do');
    return;
  }
  log.info('agent-review', `processing ${pending.length} pending paper(s)`);

  let approved = 0, rejected = 0, superseded = 0, coexisted = 0, errors = 0;

  for (const row of pending) {
    // Shape the row for the agent. source_meta.authority is the trust v2
    // enrichment we stashed at ingest; pass it through so the agent has
    // the same signals the trust score used.
    const sourceMeta = (row.source_meta ?? {}) as Record<string, any>;
    const authority = sourceMeta.authority as PendingPaperForAgent['authority'] | undefined;
    const paper: PendingPaperForAgent = {
      pending_id: row.pending_id as string,
      title: row.title as string,
      url: row.url as string,
      source: row.source as string,
      authors: Array.isArray(row.authors) ? (row.authors as string[]) : [],
      journal: (row.journal as string | null) ?? null,
      pub_year: (row.pub_year as number | null) ?? null,
      topic_tags: Array.isArray(row.topic_tags) ? (row.topic_tags as string[]) : [],
      trust_score: Number(row.trust_score ?? 0.5),
      study_design: row.study_design as string,
      confidence: row.confidence as string,
      license: typeof sourceMeta.license === 'string' ? sourceMeta.license : null,
      population: row.population as string,
      intervention: row.intervention as string,
      key_finding: row.key_finding as string,
      practical_takeaway: row.practical_takeaway as string,
      ingested_at: row.ingested_at as string,
      contradiction_flags: Array.isArray(row.contradiction_flags)
        ? (row.contradiction_flags as PendingPaperForAgent['contradiction_flags'])
        : [],
      authority,
    };

    let decision: AgentDecision;
    try {
      decision = await runAgentReview(paper);
    } catch (e) {
      log.error('agent-review', `Sonnet call failed for ${paper.title.slice(0, 60)}`, {
        error: String(e).slice(0, 200),
      });
      errors += 1;
      continue;
    }

    log.info('agent-review', `decision: ${decision.final_action}${decision.proposed_action !== decision.final_action ? ` (proposed ${decision.proposed_action})` : ''}`, {
      url: paper.url,
      confidence: decision.confidence,
      flags: decision.flags,
      superseded_count: decision.superseded_kb_ids.length,
      downgrade: decision.downgrade_reason,
    });

    if (opts.dryRun) {
      log.info('agent-review', '[DRY] would apply', {
        pending_id: paper.pending_id,
        action: decision.final_action,
      });
      continue;
    }

    // Apply the decision.
    let newKbId: string | null = null;
    try {
      if (decision.final_action === 'reject') {
        const { error: rErr } = await client.rpc('reject_pending', {
          p_pending_id: paper.pending_id,
          p_reason: decision.rationale.slice(0, 200),
          p_reviewer: 'agent',
        });
        if (rErr) throw new Error(`reject_pending: ${rErr.message}`);
        rejected += 1;
      } else {
        // approve / supersede / coexist all promote the paper first.
        const { data: kbId, error: pErr } = await client.rpc('promote_pending_to_kb', {
          p_pending_id: paper.pending_id,
          p_reviewer: 'agent',
        });
        if (pErr) throw new Error(`promote_pending_to_kb: ${pErr.message}`);
        newKbId = kbId as string;

        if (decision.final_action === 'supersede' && decision.superseded_kb_ids.length > 0) {
          // Each supersede target is independent; partial failure is OK
          // (the new kb row stays; we just don't get the supersede link).
          for (const targetId of decision.superseded_kb_ids) {
            const { error: sErr } = await client.rpc('supersede_kb', {
              p_superseded_id: targetId,
              p_by_id: newKbId,
              p_reviewer: 'agent',
            });
            if (sErr) {
              log.warn('agent-review', `supersede_kb failed for target ${targetId}`, {
                error: sErr.message,
              });
            }
          }
          superseded += 1;
        } else if (decision.final_action === 'approve') {
          approved += 1;
        } else {
          coexisted += 1;
        }
      }
    } catch (e) {
      log.error('agent-review', `applying decision failed; logging anyway`, {
        url: paper.url,
        action: decision.final_action,
        error: String(e).slice(0, 200),
      });
      errors += 1;
      // Don't insert a log row when the apply step failed — next cron will
      // retry. Otherwise we'd have an orphan log claiming "approved" with
      // no kb row.
      continue;
    }

    // Audit log.
    try {
      const { error: lErr } = await client.from('agent_review_log').insert({
        pending_id: paper.pending_id,
        paper_url: paper.url,
        paper_title: paper.title,
        proposed_action: decision.proposed_action,
        final_action: decision.final_action,
        downgrade_reason: decision.downgrade_reason,
        rationale: decision.rationale,
        confidence: decision.confidence,
        flags: decision.flags,
        superseded_kb_ids: decision.superseded_kb_ids,
        new_kb_id: newKbId,
        agent_model: 'claude-sonnet-4-6',
        raw_response: decision.raw_response as object,
      });
      if (lErr) {
        log.error('agent-review', `agent_review_log insert failed`, {
          error: lErr.message,
        });
      }
    } catch (e) {
      log.error('agent-review', `agent_review_log threw`, {
        error: String(e).slice(0, 200),
      });
    }
  }

  log.info('agent-review', 'done', {
    processed: pending.length,
    approved, rejected, superseded, coexisted, errors,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  // Review-mode never calls Voyage (no embedding work), so we don't
  // require VOYAGE_API_KEY in that path. Ingest mode requires the full set.
  assertRequiredEnv({ needsVoyage: !opts.reviewMode });

  log.info('orch', 'config', {
    mode: opts.reviewMode ? 'review' : 'ingest',
    dry_run: opts.dryRun,
    total_papers_budget: opts.maxPapers,
    source_filter: opts.sourceFilter,
    skip_topic_plan: opts.skipTopicPlan,
    review_age_hours: opts.reviewAgeHours,
  });

  const client = makeServiceClient();

  // Branch: --review skips ingestion and runs the agent pass.
  if (opts.reviewMode) {
    await runAgentReviewPass(client, opts);
    process.exit(0);
  }

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
  // Each topic-plan item fans out to one or more sources via sourcesForItem
  // (trending → europe_pmc + biorxiv + sportrxiv, user_need/gap → europe_pmc
  // only). Each (source, budget_share) pair runs as its own fetch. Per-source
  // checkpoints aggregate watermarks ACROSS topic items and get updated once
  // at the end. Cross-source dedupe via seenUrls — same paper appearing in
  // two source queries is processed once.
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
    const shares = sourcesForItem(item);
    for (const { source, budget } of shares) {
      if (opts.sourceFilter && source.name !== opts.sourceFilter) {
        log.skip('orch', `share skipped by --source filter`, {
          topic: item.label, source: source.name,
        });
        continue;
      }
      // Each share runs as its own topic-item sub-fetch with its own budget.
      // We synthesize a per-share TopicPlanItem so runTopicItem gets the
      // right budget; the bucket / label / queryTerms pass through so
      // source_meta on each paper still carries the topic context.
      const shareItem: TopicPlanItem = { ...item, budget };

      const checkpoint = await getCheckpoint(client, source.name);
      let r: Awaited<ReturnType<typeof runTopicItem>> | null = null;
      try {
        r = await runTopicItem(client, source, shareItem, denylist, opts, checkpoint, seenUrls, voyageCallsSoFar);
        if (r.error === null) anySucceeded = true;
        totalAdded += r.added;
      } catch (e) {
        log.error('orch', `runTopicItem(${source.name}/${item.label}) threw`, { error: String(e).slice(0, 200) });
      }

      // Roll up per-source watermarks across all (item × source) shares.
      if (r) {
        const agg = aggregatedBySource.get(source.name) ?? {
          fetched: 0, added: 0, lastIdentifier: null, lastPubDate: null, error: null,
        };
        agg.fetched += r.fetched;
        agg.added += r.added;
        if (r.error) agg.error = r.error;
        // Watermarks: keep the highest seen. lastIdentifier is opaque per
        // source so we just keep the last non-null; lastPubDate is ISO so
        // lex-max works.
        if (r.lastIdentifier) agg.lastIdentifier = r.lastIdentifier;
        if (r.lastPubDate && (!agg.lastPubDate || r.lastPubDate > agg.lastPubDate)) {
          agg.lastPubDate = r.lastPubDate;
        }
        aggregatedBySource.set(source.name, agg);
      }
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
