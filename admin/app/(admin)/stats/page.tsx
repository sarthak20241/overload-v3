/**
 * Stats — counts, last-cron timestamps per source, top topic distribution.
 *
 * v1 is summary-card based. Charts (papers added over time, rejection
 * reason breakdown) land in a follow-up commit once we have more data and
 * decide on a chart library (probably recharts).
 */
import Link from 'next/link';
import { getSupabaseServerClient } from '@/lib/supabase';
import type { IngestCheckpoint, ResearchStats } from '@/lib/types';
import {
  Database, Clock, Inbox, TrendingUp, AlertTriangle, ChevronRight, DollarSign,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

interface TopicCount { tag: string; count: number; }

interface CoachGap {
  /** Truncated preview of the user's message */
  preview: string;
  /** Most recent occurrence */
  last_seen: string;
  /** How many times in the window this query (by preview) returned nothing */
  count: number;
}

interface CostTotals {
  total_cost_usd: number;
  total_calls: number;
  coach_cost_usd: number;
  ingest_cost_usd: number;
  review_agent_cost_usd: number;
  eval_cost_usd: number;
  anthropic_cost_usd: number;
  voyage_cost_usd: number;
}

async function loadStats(): Promise<{
  stats: ResearchStats | null;
  checkpoints: IngestCheckpoint[];
  topTopics: TopicCount[];
  coachGaps: CoachGap[];
  cost7d: CostTotals | null;
  cost30d: CostTotals | null;
  error: string | null;
}> {
  try {
    const supabase = await getSupabaseServerClient();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [statsRes, checkpointsRes, kbRes, gapsRes, cost7Res, cost30Res] = await Promise.all([
      supabase.rpc('admin_research_stats').single(),
      supabase.from('ingest_checkpoints').select('*').order('source'),
      supabase.from('research_kb').select('topic_tags').is('superseded_by', null).limit(500),
      // Phase 3 KB-gap signal: user questions where retrieval found nothing.
      // Caps at 200 raw rows; we de-dup by preview client-side. Phase 4
      // adds Haiku clustering on top of this.
      supabase
        .from('coach_traces')
        .select('last_user_message_preview, request_at, retrieval_status')
        .eq('retrieval_status', 'no_matches')
        .not('last_user_message_preview', 'is', null)
        .gte('request_at', sevenDaysAgo)
        .order('request_at', { ascending: false })
        .limit(200),
      supabase.rpc('cost_totals', { p_since: sevenDaysAgo }).single(),
      supabase.rpc('cost_totals', { p_since: thirtyDaysAgo }).single(),
    ]);

    // Supabase v2: rpc()/select() don't throw on backend errors. Check
    // each so a failed source surfaces as the page error banner instead
    // of an empty card. cost_*Res use .single() and may return PGRST116
    // (no rows) when there's literally zero traffic in the window —
    // that's not a real failure; only treat it as one if a non-PGRST116
    // error is present.
    type PgErr = { code?: string; message?: string } | null | undefined;
    const isFatal = (e: PgErr): boolean => Boolean(e) && e!.code !== 'PGRST116';
    const fatalMsg = (e: PgErr): string | undefined => (isFatal(e) ? e!.message : undefined);

    if (statsRes.error || checkpointsRes.error || kbRes.error || gapsRes.error
        || isFatal(cost7Res.error) || isFatal(cost30Res.error)) {
      // Walk the same order as the if-condition. Use fatalMsg() for the
      // cost responses so a benign PGRST116 doesn't hijack the banner
      // when the real error is on a different query.
      const firstErr =
        statsRes.error?.message
        ?? checkpointsRes.error?.message
        ?? kbRes.error?.message
        ?? gapsRes.error?.message
        ?? fatalMsg(cost7Res.error)
        ?? fatalMsg(cost30Res.error)
        ?? 'Failed to load stats';
      return {
        stats: null, checkpoints: [], topTopics: [], coachGaps: [],
        cost7d: null, cost30d: null, error: firstErr,
      };
    }

    const raw = (statsRes.data ?? null) as Record<string, unknown> | null;
    const stats: ResearchStats | null = raw
      ? {
          pending_count: Number(raw.pending_count ?? 0),
          approved_today: Number(raw.approved_today ?? 0),
          rejected_today: Number(raw.rejected_today ?? 0),
          kb_total: Number(raw.kb_total ?? 0),
          last_cron_at: typeof raw.last_cron_at === 'string' ? raw.last_cron_at : null,
        }
      : null;

    const checkpoints = (checkpointsRes.data ?? []) as IngestCheckpoint[];

    const tagCounts = new Map<string, number>();
    for (const row of (kbRes.data ?? [])) {
      const tags = (row.topic_tags ?? []) as string[];
      for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const topTopics = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag, count]) => ({ tag, count }));

    // Dedup retrieval-gap rows by preview, keep the most-recent timestamp +
    // the occurrence count. Surfaces "users keep asking about X and we
    // have nothing on it."
    const gapMap = new Map<string, { last_seen: string; count: number }>();
    for (const row of (gapsRes.data ?? []) as { last_user_message_preview: string; request_at: string }[]) {
      const key = (row.last_user_message_preview ?? '').trim().toLowerCase();
      if (!key) continue;
      const existing = gapMap.get(key);
      if (existing) {
        existing.count += 1;
        if (row.request_at > existing.last_seen) existing.last_seen = row.request_at;
      } else {
        gapMap.set(key, { last_seen: row.request_at, count: 1 });
      }
    }
    const coachGaps: CoachGap[] = [...gapMap.entries()]
      .map(([preview, { last_seen, count }]) => ({ preview, last_seen, count }))
      .sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen))
      .slice(0, 12);

    const toCostTotals = (r: unknown): CostTotals | null => {
      const o = r as Record<string, unknown> | null;
      if (!o) return null;
      return {
        total_cost_usd:        Number(o.total_cost_usd ?? 0),
        total_calls:           Number(o.total_calls ?? 0),
        coach_cost_usd:        Number(o.coach_cost_usd ?? 0),
        ingest_cost_usd:       Number(o.ingest_cost_usd ?? 0),
        review_agent_cost_usd: Number(o.review_agent_cost_usd ?? 0),
        eval_cost_usd:         Number(o.eval_cost_usd ?? 0),
        anthropic_cost_usd:    Number(o.anthropic_cost_usd ?? 0),
        voyage_cost_usd:       Number(o.voyage_cost_usd ?? 0),
      };
    };

    return {
      stats,
      checkpoints,
      topTopics,
      coachGaps,
      cost7d: toCostTotals(cost7Res.data),
      cost30d: toCostTotals(cost30Res.data),
      error: null,
    };
  } catch (e) {
    return {
      stats: null, checkpoints: [], topTopics: [], coachGaps: [],
      cost7d: null, cost30d: null,
      error: String(e),
    };
  }
}

function timeSince(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function StatsPage() {
  const { stats, checkpoints, topTopics, coachGaps, cost7d, cost30d, error } = await loadStats();
  const maxTopicCount = topTopics[0]?.count ?? 1;
  const maxGapCount = coachGaps[0]?.count ?? 1;

  return (
    <div className="h-screen overflow-y-auto">
      <div className="px-8 py-5 border-b border-border">
        <h1 className="text-xl font-semibold text-fg">Stats</h1>
        <p className="text-xs text-muted-fg mt-0.5">
          Pipeline health and corpus shape
        </p>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 text-sm text-danger">
          Failed to load: {error}
        </div>
      )}

      <div className="px-8 py-6 space-y-6">
        {/* Stat cards */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<Inbox size={14} />}
            label="Pending review"
            value={stats?.pending_count ?? 0}
            accent
          />
          <StatCard
            icon={<TrendingUp size={14} />}
            label="Approved today"
            value={stats?.approved_today ?? 0}
          />
          <StatCard
            icon={<TrendingUp size={14} />}
            label="Rejected today"
            value={stats?.rejected_today ?? 0}
          />
          <StatCard
            icon={<Database size={14} />}
            label="In knowledge base"
            value={stats?.kb_total ?? 0}
          />
        </div>

        {/*
          Cost preview card — links to /cost for the full breakdown.
          Shows last-7d / last-30d totals plus a tiny per-pipeline split.
          Surfaces the agent-vs-coach-vs-ingest cost mix at a glance so the
          reviewer notices if any pipeline runs away.
        */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs uppercase tracking-widest text-text-muted flex items-center gap-1.5">
              <DollarSign size={12} /> Token spend
            </h2>
            <Link
              href="/cost"
              className="text-xs text-primary hover:underline flex items-center gap-0.5"
            >
              Full breakdown <ChevronRight size={12} />
            </Link>
          </div>
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
            <CostPreviewCard label="Last 7 days"  totals={cost7d} />
            <CostPreviewCard label="Last 30 days" totals={cost30d} />
          </div>
        </section>

        {/*
          KB-gap signals: user questions where retrieval returned no
          matches in the last 7 days, deduped by message preview. Each row
          shows the question, how many times users asked it, and when it
          was last asked. This is the data that drives topic-driven
          fetching later — manual right now (you SQL these into a new
          ingest query), automated when Phase 4 wires the clustering
          step in.
        */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs uppercase tracking-widest text-text-muted flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-warning" />
              Questions the KB couldn&apos;t answer (last 7d)
            </h2>
            <span className="text-[10px] text-text-muted">
              {coachGaps.length} distinct queries
            </span>
          </div>
          {coachGaps.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-fg text-sm">
              No retrieval gaps in the last 7 days — either the coach hasn&apos;t
              been used or every query found at least one match.
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card p-4 space-y-2.5">
              {coachGaps.map((g, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <span className="text-text-muted tabular-nums w-6 text-right text-xs font-semibold mt-0.5">
                    ×{g.count}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-fg leading-snug line-clamp-2">{g.preview}</p>
                    <p className="text-[10px] text-text-muted mt-0.5">
                      last seen {timeSince(g.last_seen)}
                    </p>
                  </div>
                  <div className="flex-none w-16 h-1.5 bg-bg-elevated rounded-full overflow-hidden mt-1.5">
                    <div
                      className="h-full bg-warning"
                      style={{ width: `${(g.count / maxGapCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Source checkpoints */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-text-muted mb-3">
            Ingestion sources
          </h2>
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated border-b border-border">
                <tr className="text-left">
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">Source</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">Last run</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Fetched</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Added</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">Last error</th>
                </tr>
              </thead>
              <tbody>
                {checkpoints.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-fg text-sm">No source checkpoints yet</td></tr>
                ) : checkpoints.map((c) => (
                  <tr key={c.source} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5 text-fg font-mono text-xs">{c.source}</td>
                    <td className="px-4 py-2.5 text-muted-fg">
                      <div className="flex items-center gap-1.5">
                        <Clock size={11} className="text-text-muted" />
                        {timeSince(c.last_run_at)}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-fg">{c.papers_fetched}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg font-medium">{c.papers_added}</td>
                    <td className="px-4 py-2.5 text-danger text-xs">
                      {c.last_error ? c.last_error.slice(0, 60) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Top topics */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-text-muted mb-3">
            Top topics in knowledge base (top 15)
          </h2>
          {topTopics.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-fg text-sm">
              No tagged entries yet
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              {topTopics.map(({ tag, count }) => (
                <div key={tag} className="flex items-center gap-3 text-sm">
                  <span className="text-muted-fg w-44 text-xs font-mono truncate">{tag}</span>
                  <div className="flex-1 h-2 bg-bg-elevated rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${(count / maxTopicCount) * 100}%` }}
                    />
                  </div>
                  <span className="text-fg tabular-nums w-8 text-right text-xs font-semibold">{count}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({
  icon, label, value, accent = false,
}: { icon: React.ReactNode; label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={
      'p-4 rounded-lg border ' +
      (accent ? 'bg-primary-subtle border-primary-muted' : 'bg-card border-border')
    }>
      <div className={'flex items-center gap-1.5 ' + (accent ? 'text-primary/80' : 'text-text-muted')}>
        {icon}
        <span className="text-[10px] uppercase tracking-widest">{label}</span>
      </div>
      <div className={'text-2xl font-bold tabular-nums mt-2 ' + (accent ? 'text-primary' : 'text-fg')}>
        {value}
      </div>
    </div>
  );
}

/**
 * Cost preview card on the Stats page. Mini-version of what the /cost
 * page shows — total + per-pipeline split + per-provider split.
 * Designed to fit two side-by-side on desktop (7d + 30d) without making
 * the page top-heavy.
 */
function CostPreviewCard({
  label, totals,
}: { label: string; totals: CostTotals | null }) {
  if (!totals || totals.total_calls === 0) {
    return (
      <div className="p-4 rounded-lg border border-border bg-card">
        <div className="text-[10px] uppercase tracking-widest text-text-muted mb-2">{label}</div>
        <div className="text-sm text-muted-fg">No API calls logged in this window.</div>
      </div>
    );
  }
  const total = totals.total_cost_usd;
  return (
    <div className="p-4 rounded-lg border border-border bg-card">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
        <div className="text-[10px] text-text-muted tabular-nums">
          {totals.total_calls.toLocaleString()} calls
        </div>
      </div>
      <div className="text-3xl font-bold tabular-nums text-fg mb-3">
        ${total.toFixed(2)}
      </div>
      <div className="space-y-1.5 text-[11px]">
        <CostRow label="Coach inference"   value={totals.coach_cost_usd}        total={total} color="primary" />
        <CostRow label="Ingest (Haiku + Voyage)" value={totals.ingest_cost_usd}        total={total} color="info" />
        <CostRow label="Review agent"      value={totals.review_agent_cost_usd} total={total} color="warning" />
        <CostRow label="Eval harness"      value={totals.eval_cost_usd}         total={total} color="muted" />
      </div>
      <div className="mt-3 pt-2 border-t border-border/60 flex justify-between text-[10px] text-text-muted">
        <span>Anthropic ${totals.anthropic_cost_usd.toFixed(2)}</span>
        <span>Voyage ${totals.voyage_cost_usd.toFixed(2)}</span>
      </div>
    </div>
  );
}

function CostRow({
  label, value, total, color,
}: {
  label: string;
  value: number;
  total: number;
  color: 'primary' | 'info' | 'warning' | 'muted';
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const barCls =
    color === 'primary' ? 'bg-primary' :
    color === 'info'    ? 'bg-info'    :
    color === 'warning' ? 'bg-warning' :
                          'bg-text-muted';
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-fg w-32 truncate">{label}</span>
      <div className="flex-1 h-1 bg-bg-elevated rounded-full overflow-hidden">
        <div className={'h-full ' + barCls} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="text-fg tabular-nums w-14 text-right font-medium">
        ${value.toFixed(2)}
      </span>
    </div>
  );
}
