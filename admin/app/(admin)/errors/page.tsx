/**
 * Errors — failed coach turns + ingest failures, grouped by category.
 *
 * Source: coach_traces (status != 'success') + token_usage_log (status='error').
 * Joined views let the page surface infrastructure pain without bouncing
 * between Conversations and the Cost log.
 *
 * Each row exposes the error_message + full context (user, model, latency)
 * so triage is one click rather than five SQL queries.
 */
import { getSupabaseServerClient } from '@/lib/supabase';
import { AlertCircle, AlertTriangle, Bug } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface ErrorRow {
  source: 'coach' | 'token_usage';
  recorded_at: string;
  user_id: string | null;
  status: string;
  model: string | null;
  error_message: string | null;
  pipeline: string | null;
  latency_ms: number | null;
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function loadErrors(): Promise<{
  errors: ErrorRow[];
  countsByStatus: Record<string, number>;
  countsByModel: Record<string, number>;
  error: string | null;
}> {
  try {
    const supabase = await getSupabaseServerClient();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [coachErrRes, usageErrRes] = await Promise.all([
      supabase
        .from('coach_traces')
        .select('user_id, request_at, status, model, error_message, latency_ms')
        .neq('status', 'success')
        .gte('request_at', sevenDaysAgo)
        .order('request_at', { ascending: false })
        .limit(200),
      supabase
        .from('token_usage_log')
        .select('recorded_at, pipeline, model, status, error_message, latency_ms, metadata')
        .eq('status', 'error')
        .gte('recorded_at', sevenDaysAgo)
        .order('recorded_at', { ascending: false })
        .limit(200),
    ]);

    const errors: ErrorRow[] = [];

    for (const r of (coachErrRes.data ?? []) as Array<Record<string, unknown>>) {
      errors.push({
        source: 'coach',
        recorded_at: String(r.request_at),
        user_id: r.user_id ? String(r.user_id) : null,
        status: String(r.status),
        model: r.model ? String(r.model) : null,
        error_message: r.error_message ? String(r.error_message) : null,
        pipeline: 'coach',
        latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
      });
    }
    for (const r of (usageErrRes.data ?? []) as Array<Record<string, unknown>>) {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      errors.push({
        source: 'token_usage',
        recorded_at: String(r.recorded_at),
        user_id: meta.user_id ? String(meta.user_id) : null,
        status: 'error',
        model: r.model ? String(r.model) : null,
        error_message: r.error_message ? String(r.error_message) : null,
        pipeline: r.pipeline ? String(r.pipeline) : null,
        latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
      });
    }
    errors.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));

    const countsByStatus: Record<string, number> = {};
    const countsByModel: Record<string, number> = {};
    for (const e of errors) {
      countsByStatus[e.status] = (countsByStatus[e.status] ?? 0) + 1;
      const m = e.model ?? 'unknown';
      countsByModel[m] = (countsByModel[m] ?? 0) + 1;
    }

    return { errors, countsByStatus, countsByModel, error: null };
  } catch (e) {
    return { errors: [], countsByStatus: {}, countsByModel: {}, error: String(e) };
  }
}

export default async function ErrorsPage() {
  const { errors, countsByStatus, countsByModel, error } = await loadErrors();

  return (
    <div className="h-screen overflow-y-auto">
      <div className="px-8 py-5 border-b border-border">
        <h1 className="text-xl font-semibold text-fg flex items-center gap-2">
          <Bug size={18} />
          Errors
        </h1>
        <p className="text-xs text-muted-fg mt-0.5">
          Failed coach turns + ingest/embedding errors · last 7 days · max 400 rows
        </p>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger" />
          <span className="text-sm text-danger">Failed to load: {error}</span>
        </div>
      )}

      <div className="px-8 py-6 space-y-6">
        {/* Summary cards */}
        {errors.length > 0 && (
          <>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
              <BucketCard title="By status / error type" entries={countsByStatus} />
              <BucketCard title="By model"               entries={countsByModel} />
            </div>
          </>
        )}

        {/* Detail list */}
        {errors.length === 0 && !error ? (
          <div className="rounded-lg border border-border bg-card p-12 text-center">
            <AlertTriangle size={36} className="text-primary mx-auto mb-3" />
            <p className="text-fg font-medium">No errors in the last 7 days</p>
            <p className="text-sm text-muted-fg mt-1">
              Everything is happy. The dashboard will surface failures here
              the moment they start.
            </p>
          </div>
        ) : (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-text-muted mb-3">
              Recent failures ({errors.length})
            </h2>
            <div className="rounded-lg border border-border bg-card divide-y divide-border/60">
              {errors.map((e, i) => (
                <ErrorRow key={i} row={e} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function BucketCard({ title, entries }: { title: string; entries: Record<string, number> }) {
  const sorted = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] ?? 1;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-3">{title}</div>
      <div className="space-y-1.5">
        {sorted.map(([k, n]) => (
          <div key={k} className="flex items-center gap-2 text-xs">
            <span className="text-fg w-44 truncate font-mono">{k}</span>
            <div className="flex-1 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full bg-danger" style={{ width: `${(n / max) * 100}%` }} />
            </div>
            <span className="text-fg tabular-nums w-10 text-right font-semibold">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorRow({ row }: { row: ErrorRow }) {
  return (
    <div className="p-4">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="px-1.5 py-0.5 rounded bg-danger/15 border border-danger/30 text-danger text-[10px] font-bold uppercase tracking-wide">
          {row.status}
        </span>
        <span className="text-[10px] text-text-muted">·</span>
        <span className="text-[10px] text-text-muted">{row.pipeline ?? 'unknown'}</span>
        <span className="text-[10px] text-text-muted">·</span>
        <span className="text-[10px] text-text-muted font-mono">{row.model ?? 'unknown'}</span>
        <span className="text-[10px] text-text-muted">·</span>
        <span className="text-[10px] text-text-muted">{timeSince(row.recorded_at)}</span>
        {row.user_id && (
          <>
            <span className="text-[10px] text-text-muted">·</span>
            <span className="text-[10px] text-muted-fg font-mono">user {row.user_id.slice(-5)}</span>
          </>
        )}
        {row.latency_ms !== null && (
          <>
            <span className="text-[10px] text-text-muted">·</span>
            <span className="text-[10px] text-text-muted tabular-nums">{(row.latency_ms / 1000).toFixed(1)}s</span>
          </>
        )}
      </div>
      {row.error_message && (
        <pre className="text-xs text-danger/90 font-mono whitespace-pre-wrap break-words leading-relaxed">
          {row.error_message}
        </pre>
      )}
    </div>
  );
}
