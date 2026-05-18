/**
 * Service-role Supabase client + helpers for checkpoints, denylist, dedupe,
 * and pending-row inserts.
 *
 * The cron worker is server-only and authenticated as service_role, so RLS
 * is bypassed. The helpers here are the only thing the worker uses to touch
 * the DB — no raw client exposure from elsewhere.
 *
 * Every fetch-bound operation goes through `withRetry` because PostgREST's
 * fetch occasionally throws `TypeError: fetch failed` on transient network
 * hiccups (DNS, idle-connection resets, brief connection-pool exhaustion).
 * Without retry the first hiccup kills the worker mid-run; with retry the
 * cron rides through.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from './env.js';
import type { Checkpoint, Distillation, Paper } from './types.js';

export function makeServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Retry helper ─────────────────────────────────────────────────────────────
// Wraps any async Supabase call. Retries on transient network errors
// (TypeError: fetch failed, ECONNRESET, ETIMEDOUT) with exponential backoff.
// Does NOT retry on Postgres errors (constraint violations, missing columns)
// — those are bugs we want to surface, not paper over.
const SUPA_RETRY_DELAYS_MS = [500, 2_000, 5_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransientFetchError(e: unknown): boolean {
  const msg = String(e);
  return (
    msg.includes('fetch failed') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('socket hang up') ||
    msg.includes('UND_ERR_SOCKET') // undici socket error class
  );
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= SUPA_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientFetchError(e)) throw e;
      if (attempt < SUPA_RETRY_DELAYS_MS.length) {
        const waitMs = SUPA_RETRY_DELAYS_MS[attempt];
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            source: 'supabase',
            msg: `transient fetch error on ${label}; retrying in ${waitMs}ms`,
            attempt: attempt + 1,
            error: String(e).slice(0, 200),
          }),
        );
        await sleep(waitMs);
      }
    }
  }
  throw lastErr;
}

// ── Checkpoints ──────────────────────────────────────────────────────────────
export async function getCheckpoint(
  client: SupabaseClient,
  source: string,
): Promise<Checkpoint> {
  return withRetry(`getCheckpoint(${source})`, async () => {
    const { data, error } = await client
      .from('ingest_checkpoints')
      .select('*')
      .eq('source', source)
      .single();
    if (error || !data) {
      // Source not yet seeded — pretend it's an empty 1970 start.
      return {
        source,
        last_fetched_at: '1970-01-01T00:00:00.000Z',
        last_pub_date: null,
        last_identifier: null,
        papers_fetched: 0,
        papers_added: 0,
        last_run_at: null,
        last_error: null,
      };
    }
    return data as Checkpoint;
  });
}

export async function updateCheckpoint(
  client: SupabaseClient,
  source: string,
  patch: {
    last_pub_date?: string | null;
    last_identifier?: string | null;
    papers_fetched_delta: number;
    papers_added_delta: number;
    last_error?: string | null;
  },
): Promise<void> {
  const current = await getCheckpoint(client, source);
  const next = {
    source,
    last_fetched_at: new Date().toISOString(),
    last_pub_date: patch.last_pub_date ?? current.last_pub_date,
    last_identifier: patch.last_identifier ?? current.last_identifier,
    papers_fetched: current.papers_fetched + patch.papers_fetched_delta,
    papers_added: current.papers_added + patch.papers_added_delta,
    last_run_at: new Date().toISOString(),
    last_error: patch.last_error ?? null,
  };
  await withRetry(`updateCheckpoint(${source})`, async () => {
    const { error } = await client.from('ingest_checkpoints').upsert(next, { onConflict: 'source' });
    if (error) throw new Error(`updateCheckpoint failed: ${error.message}`);
  });
}

// ── Denylist + dedupe ────────────────────────────────────────────────────────
let _denylistCache: string[] | null = null;

export async function loadDenylist(client: SupabaseClient): Promise<string[]> {
  if (_denylistCache) return _denylistCache;
  _denylistCache = await withRetry('loadDenylist', async () => {
    const { data, error } = await client.from('publisher_denylist').select('pattern');
    if (error) throw new Error(`loadDenylist failed: ${error.message}`);
    return (data ?? []).map((r) => r.pattern as string);
  });
  return _denylistCache;
}

export function isDenied(url: string, patterns: string[]): string | null {
  const lower = url.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p.toLowerCase())) return p;
  }
  return null;
}

/**
 * Returns true if `url` already exists in either research_kb or
 * research_kb_pending. Used to skip duplicates before spending Haiku tokens.
 */
export async function isAlreadyIngested(
  client: SupabaseClient,
  url: string,
): Promise<boolean> {
  return withRetry(`isAlreadyIngested(${url.slice(0, 60)})`, async () => {
    const { count: kbCount, error: kbErr } = await client
      .from('research_kb')
      .select('id', { count: 'exact', head: true })
      .eq('url', url);
    if (kbErr) throw new Error(`dedupe kb check failed: ${kbErr.message}`);
    if ((kbCount ?? 0) > 0) return true;

    const { count: pendingCount, error: pendingErr } = await client
      .from('research_kb_pending')
      .select('id', { count: 'exact', head: true })
      .eq('url', url);
    if (pendingErr) throw new Error(`dedupe pending check failed: ${pendingErr.message}`);
    return (pendingCount ?? 0) > 0;
  });
}

// ── Pending insert ───────────────────────────────────────────────────────────
export async function insertPending(
  client: SupabaseClient,
  paper: Paper,
  dist: Distillation,
  embedding: number[],
  trustScore: number,
): Promise<string> {
  const row = {
    source: paper.source,
    url: paper.url,
    title: paper.title,
    authors: paper.authors,
    journal: paper.journal ?? null,
    pub_year: paper.pub_year ?? null,
    pub_date: paper.pub_date ?? null,
    topic_tags: dist.topic_tags,
    study_design: dist.study_design,
    confidence: dist.confidence,
    population: dist.population,
    intervention: dist.intervention,
    key_finding: dist.key_finding,
    practical_takeaway: dist.practical_takeaway,
    trust_score: trustScore,
    license: paper.license ?? null,
    embedding: JSON.stringify(embedding),
    source_meta: paper.source_meta ?? null,
    review_status: 'pending',
  };
  return withRetry(`insertPending(${paper.url.slice(0, 60)})`, async () => {
    const { data, error } = await client
      .from('research_kb_pending')
      .insert(row)
      .select('id')
      .single();
    if (error) throw new Error(`insertPending failed: ${error.message}`);
    return data!.id as string;
  });
}
