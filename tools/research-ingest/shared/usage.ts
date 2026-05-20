/**
 * Token-usage logging helper for the cost observability dashboard.
 *
 * Every Anthropic + Voyage call writes one row to token_usage_log via the
 * log_token_usage() Postgres RPC. Cost is computed server-side from
 * model_pricing — see migration 0024.
 *
 * Design notes:
 *   - Lazy service-role client so a worker that never calls logUsage()
 *     (e.g., --dry-run) doesn't pay the makeClient cost.
 *   - Best-effort: logging failures are caught + warned but never throw.
 *     We never want a cost-logging blip to drop a paper mid-pipeline.
 *   - Fire-and-forget by default. Callers can `await` if they want
 *     ordering guarantees (rare).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeServiceClient } from './supabase.js';
import { log } from './log.js';

let _client: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (!_client) _client = makeServiceClient();
  return _client;
}

export type Pipeline =
  | 'coach'           // Sonnet inference for a coach turn (logged by edge fn)
  | 'ingest_distill'  // Haiku distillation of one paper
  | 'review_agent'    // Sonnet 24h auto-review of one pending paper
  | 'embed_ingest'    // Voyage doc embed during ingest
  | 'embed_query'     // Voyage query embed at retrieval time
  | 'eval_coach'      // Sonnet during eval harness run
  | 'eval_judge';     // Opus judging during eval harness run

export type Provider = 'anthropic' | 'voyage';

export interface UsageRecord {
  pipeline: Pipeline;
  provider: Provider;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  /** Free-form context: paper_id, user_id, doi, prompt_type, etc. */
  metadata?: Record<string, unknown>;
  latency_ms?: number;
  status?: 'success' | 'error';
  error_message?: string;
}

/**
 * Log one token-usage row. Returns a promise the caller MAY await; most
 * sites fire-and-forget. Errors are swallowed (with a log) so logging
 * issues never affect the calling pipeline.
 */
export async function logUsage(rec: UsageRecord): Promise<void> {
  try {
    const { error } = await getClient().rpc('log_token_usage', {
      p_pipeline: rec.pipeline,
      p_provider: rec.provider,
      p_model: rec.model,
      p_input_tokens: rec.input_tokens ?? 0,
      p_output_tokens: rec.output_tokens ?? 0,
      p_cache_read_tokens: rec.cache_read_tokens ?? 0,
      p_cache_creation_tokens: rec.cache_creation_tokens ?? 0,
      p_metadata: rec.metadata ?? null,
      p_latency_ms: rec.latency_ms ?? null,
      p_status: rec.status ?? 'success',
      p_error_message: rec.error_message ?? null,
    });
    if (error) {
      log.warn('usage', 'log_token_usage rpc returned error', {
        error: error.message.slice(0, 200),
        pipeline: rec.pipeline,
        model: rec.model,
      });
    }
  } catch (e) {
    log.warn('usage', 'logUsage threw — swallowing', {
      error: String(e).slice(0, 200),
      pipeline: rec.pipeline,
      model: rec.model,
    });
  }
}
