/**
 * Advisory agent review over EXISTING pending papers.
 *
 * `curated.ts` writes an advisory `agent_recommendation` for the papers IT
 * ingests. But the nightly cron (`run.ts`) also lands papers in
 * `research_kb_pending`, and those don't carry an advisory remark (the cron's
 * own agent pass APPLIES decisions at the 24h mark instead of advising).
 *
 * This script makes the review queue uniform: it runs the SAME Sonnet
 * auto-review agent (`shared/agent-review.ts`) in advisory mode over every
 * pending row that doesn't yet have an `agent_recommendation`, and writes the
 * agent's verdict (add/skip) + reasoning so the human reviewer sees, on EVERY
 * card, what the agent thinks and what decision it would have taken. Nothing
 * is applied — promote/reject stays a human click in the admin queue.
 *
 *   npx tsx tools/research-ingest/advise-pending.ts --dry-run   # print verdicts, no DB writes
 *   npx tsx tools/research-ingest/advise-pending.ts             # review all pending rows missing a rec
 *   npx tsx tools/research-ingest/advise-pending.ts --all       # RE-review every pending row (overwrite)
 *   npx tsx tools/research-ingest/advise-pending.ts --limit=20  # cap how many to process
 */
import './shared/env.js';
import { assertRequiredEnv } from './shared/env.js';
import { log } from './shared/log.js';
import { makeServiceClient } from './shared/supabase.js';
import { runAgentReview, type PendingPaperForAgent } from './shared/agent-review.js';

const AGENT_REVIEW_DELAY_MS = 8_000; // Sonnet tier-1 throttle
const RETRY_BACKOFF_MS = [25_000, 60_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

interface CliOpts { dryRun: boolean; all: boolean; limit: number | null; }
function parseArgs(): CliOpts {
  const o: CliOpts = { dryRun: false, all: false, limit: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--all') o.all = true;
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice('--limit='.length));
    else if (a === '--help' || a === '-h') {
      console.log('Usage: tsx advise-pending.ts [--dry-run] [--all] [--limit=N]');
      process.exit(0);
    } else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  return o;
}

/** Reconstruct the agent's input shape from a stored pending row. */
function rowToAgentInput(row: Record<string, any>): PendingPaperForAgent {
  const sourceMeta = (row.source_meta ?? {}) as Record<string, any>;
  const authority = sourceMeta.authority as PendingPaperForAgent['authority'] | undefined;
  return {
    pending_id: String(row.id),
    title: String(row.title ?? ''),
    url: String(row.url ?? ''),
    source: String(row.source ?? ''),
    authors: Array.isArray(row.authors) ? row.authors : [],
    journal: row.journal ?? null,
    pub_year: row.pub_year ?? null,
    topic_tags: Array.isArray(row.topic_tags) ? row.topic_tags : [],
    trust_score: Number(row.trust_score ?? 0.5),
    study_design: String(row.study_design ?? ''),
    confidence: String(row.confidence ?? ''),
    license: (row.license as string | null) ?? (typeof sourceMeta.license === 'string' ? sourceMeta.license : null),
    population: String(row.population ?? ''),
    intervention: String(row.intervention ?? ''),
    key_finding: String(row.key_finding ?? ''),
    practical_takeaway: String(row.practical_takeaway ?? ''),
    ingested_at: String(row.ingested_at ?? new Date().toISOString()),
    contradiction_flags: Array.isArray(row.contradiction_flags) ? row.contradiction_flags : [],
    authority,
  };
}

async function main() {
  const opts = parseArgs();
  // No Voyage here — the agent reads the stored distillation, no embedding.
  assertRequiredEnv({ needsVoyage: false });

  const client = makeServiceClient();

  let query = client
    .from('research_kb_pending')
    .select('id,title,url,source,authors,journal,pub_year,topic_tags,trust_score,study_design,confidence,license,population,intervention,key_finding,practical_takeaway,ingested_at,contradiction_flags,source_meta')
    .eq('review_status', 'pending')
    .order('ingested_at', { ascending: true });
  if (!opts.all) query = query.is('agent_recommendation', null);
  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) { log.error('advise', `load pending failed: ${error.message}`); process.exit(1); }
  const rows = data ?? [];
  log.info('advise', `${rows.length} pending paper(s) to review`, {
    mode: opts.all ? 'all (re-review)' : 'missing-rec only',
    dry_run: opts.dryRun,
  });
  if (rows.length === 0) { log.info('advise', 'nothing to do — every pending paper already has an agent recommendation'); process.exit(0); }

  let add = 0, skip = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await sleep(AGENT_REVIEW_DELAY_MS);
    const input = rowToAgentInput(rows[i]);

    let d;
    try {
      d = await retry429('agent-review', () => runAgentReview(input));
    } catch (e) {
      log.warn('advise', 'runAgentReview threw', { pending_id: input.pending_id, error: String(e).slice(0, 160) });
      failed++;
      continue;
    }

    const verdict = d.final_action === 'reject' ? 'skip' : 'add';
    if (verdict === 'add') add++; else skip++;

    if (opts.dryRun) {
      log.info('advise', `[DRY] ${verdict.toUpperCase()} (${d.confidence.toFixed(2)}) — ${input.title.slice(0, 70)}`, { action: d.final_action });
      continue;
    }

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
    const { error: upErr } = await client
      .from('research_kb_pending')
      .update({ agent_recommendation: recommendation })
      .eq('id', input.pending_id);
    if (upErr) { log.warn('advise', 'update failed', { pending_id: input.pending_id, error: upErr.message }); failed++; }
    else log.info('advise', `agent: ${verdict.toUpperCase()} (${d.confidence.toFixed(2)}) — ${input.title.slice(0, 70)}`, { action: d.final_action });
  }

  log.info('advise', 'done', { reviewed: rows.length, agent_add: add, agent_skip: skip, failed });
  process.exit(0);
}

main().catch((err) => { log.error('advise', 'fatal', { error: String(err) }); process.exit(1); });
