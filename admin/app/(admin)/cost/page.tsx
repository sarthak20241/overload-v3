/**
 * Cost dashboard — full breakdown of Anthropic + Voyage spend.
 *
 * Server-rendered. The period is in the URL (?since=7d|30d|month|all)
 * so deep-links work and the page is shareable in screenshots. Three
 * RPCs power everything:
 *   - cost_totals      → single-row summary for stat cards
 *   - cost_summary     → per (pipeline, provider, model) for the table
 *   - cost_by_day      → daily time series for the chart, grouped by pipeline
 *
 * All three are admin-only via is_admin() — see migration 0024.
 *
 * No chart-library dependency — the time series renders as a tiny SVG
 * line + dot chart inside CostChart. Keeps the bundle slim and matches
 * the rest of the dashboard's CSS-driven look.
 */
import Link from 'next/link';
import { getSupabaseServerClient } from '@/lib/supabase';
import { DollarSign, AlertCircle, TrendingUp } from 'lucide-react';
import { CostChart } from './CostChart';

export const dynamic = 'force-dynamic';

const PERIODS = [
  { id: '7d',    label: 'Last 7 days',   days: 7   },
  { id: '30d',   label: 'Last 30 days',  days: 30  },
  { id: 'month', label: 'Month to date', days: null },  // computed below
  { id: 'all',   label: 'All time',      days: 365 * 5 },
] as const;

type PeriodId = (typeof PERIODS)[number]['id'];

interface CostTotals {
  total_cost_usd: number;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  anthropic_cost_usd: number;
  voyage_cost_usd: number;
  coach_cost_usd: number;
  ingest_cost_usd: number;
  review_agent_cost_usd: number;
  eval_cost_usd: number;
}

interface CostSummaryRow {
  pipeline: string;
  provider: string;
  model: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

interface CostByDayRow {
  day: string;        // YYYY-MM-DD
  bucket: string;     // pipeline name
  cost_usd: number;
  call_count: number;
}

function sinceFromPeriod(period: PeriodId): string {
  if (period === 'month') {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
  const days = PERIODS.find((p) => p.id === period)?.days ?? 7;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function loadCost(period: PeriodId): Promise<{
  totals: CostTotals | null;
  /** Forecast basis — always a 7d window so toggling the page period doesn't
   *  change the projection. Null when no 7d data exists. */
  sevenDayTotal: CostTotals | null;
  summary: CostSummaryRow[];
  byDay: CostByDayRow[];
  error: string | null;
  since: string;
}> {
  const since = sinceFromPeriod(period);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const supabase = await getSupabaseServerClient();
    const [totalsRes, summaryRes, byDayRes, sevenDayRes] = await Promise.all([
      supabase.rpc('cost_totals',  { p_since: since }).single(),
      supabase.rpc('cost_summary', { p_since: since }),
      supabase.rpc('cost_by_day',  { p_since: since, p_group_by: 'pipeline' }),
      // Dedicated 7d fetch so forecast stays anchored to recent rate even
      // when the page is showing 30d/month/all. Without this the forecast
      // silently changes meaning every time you toggle the period.
      supabase.rpc('cost_totals',  { p_since: sevenDaysAgo }).single(),
    ]);

    // Supabase v2: rpc() returns { data, error } without throwing on
    // backend errors. Check explicitly so a failed RPC surfaces as the
    // page's error banner instead of rendering empty cards.
    if (totalsRes.error)   throw new Error(`cost_totals: ${totalsRes.error.message}`);
    if (summaryRes.error)  throw new Error(`cost_summary: ${summaryRes.error.message}`);
    if (byDayRes.error)    throw new Error(`cost_by_day: ${byDayRes.error.message}`);
    if (sevenDayRes.error) throw new Error(`cost_totals(7d): ${sevenDayRes.error.message}`);

    const toCostTotals = (r: unknown): CostTotals | null => {
      const o = r as Record<string, unknown> | null;
      if (!o) return null;
      return {
        total_cost_usd:           Number(o.total_cost_usd ?? 0),
        total_calls:              Number(o.total_calls ?? 0),
        total_input_tokens:       Number(o.total_input_tokens ?? 0),
        total_output_tokens:      Number(o.total_output_tokens ?? 0),
        total_cache_read_tokens:  Number(o.total_cache_read_tokens ?? 0),
        anthropic_cost_usd:       Number(o.anthropic_cost_usd ?? 0),
        voyage_cost_usd:          Number(o.voyage_cost_usd ?? 0),
        coach_cost_usd:           Number(o.coach_cost_usd ?? 0),
        ingest_cost_usd:          Number(o.ingest_cost_usd ?? 0),
        review_agent_cost_usd:    Number(o.review_agent_cost_usd ?? 0),
        eval_cost_usd:            Number(o.eval_cost_usd ?? 0),
      };
    };
    const totals        = toCostTotals(totalsRes.data);
    const sevenDayTotal = toCostTotals(sevenDayRes.data);

    const summary = ((summaryRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
      pipeline:            String(r.pipeline ?? ''),
      provider:            String(r.provider ?? ''),
      model:               String(r.model ?? ''),
      call_count:          Number(r.call_count ?? 0),
      total_input_tokens:  Number(r.total_input_tokens ?? 0),
      total_output_tokens: Number(r.total_output_tokens ?? 0),
      total_cost_usd:      Number(r.total_cost_usd ?? 0),
    }));

    const byDay = ((byDayRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
      day:        String(r.day ?? ''),
      bucket:     String(r.bucket ?? ''),
      cost_usd:   Number(r.cost_usd ?? 0),
      call_count: Number(r.call_count ?? 0),
    }));

    return { totals, sevenDayTotal, summary, byDay, error: null, since };
  } catch (e) {
    return { totals: null, sevenDayTotal: null, summary: [], byDay: [], error: String(e), since };
  }
}

/** Forecast spend through the end of the current calendar month using the
 *  last 7d as the daily-rate basis. Anchored to a fixed 7d window (not the
 *  page period) so toggling the selector doesn't silently change what the
 *  number means. Scales to the actual days-in-month so the projection is
 *  right in 28/29/31-day months too. */
function forecastMonthly(sevenDayTotal: CostTotals | null): number | null {
  if (!sevenDayTotal || sevenDayTotal.total_cost_usd === 0) return null;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (sevenDayTotal.total_cost_usd / 7) * daysInMonth;
}

export default async function CostPage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodId =
    (params.since as PeriodId) === '30d'   ? '30d'   :
    (params.since as PeriodId) === 'month' ? 'month' :
    (params.since as PeriodId) === 'all'   ? 'all'   :
                                              '7d';
  const { totals, sevenDayTotal, summary, byDay, error } = await loadCost(period);
  const forecast = forecastMonthly(sevenDayTotal);

  return (
    <div className="h-screen overflow-y-auto">
      <div className="px-8 py-5 border-b border-border flex items-center justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold text-fg flex items-center gap-2">
            <DollarSign size={18} />
            Cost
          </h1>
          <p className="text-xs text-muted-fg mt-0.5">
            Token spend across Anthropic + Voyage, by pipeline and model
          </p>
        </div>
        {/* Period selector */}
        <div className="flex items-center gap-1 p-1 rounded-md bg-card border border-border">
          {PERIODS.map((p) => (
            <Link
              key={p.id}
              href={p.id === '7d' ? '/cost' : `/cost?since=${p.id}`}
              className={
                'px-2.5 py-1 rounded text-xs transition-colors ' +
                (period === p.id
                  ? 'bg-primary text-primary-fg font-semibold'
                  : 'text-muted-fg hover:text-fg')
              }
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger" />
          <span className="text-sm text-danger">Failed to load: {error}</span>
        </div>
      )}

      <div className="px-8 py-6 space-y-6">
        {/* Stat cards */}
        {totals && (
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <BigStat
              label="Total spend"
              value={`$${totals.total_cost_usd.toFixed(2)}`}
              sub={`${totals.total_calls.toLocaleString()} calls`}
              accent
            />
            <BigStat
              label="By provider"
              value={`$${totals.anthropic_cost_usd.toFixed(2)} · $${totals.voyage_cost_usd.toFixed(2)}`}
              sub="Anthropic · Voyage"
            />
            <BigStat
              label="Tokens"
              value={`${(totals.total_input_tokens + totals.total_output_tokens).toLocaleString()}`}
              sub={`${totals.total_input_tokens.toLocaleString()} in · ${totals.total_output_tokens.toLocaleString()} out`}
            />
            <BigStat
              label="Forecast monthly"
              value={forecast !== null ? `$${forecast.toFixed(2)}` : '—'}
              sub={forecast !== null ? 'based on last 7d × days-in-month' : ''}
              icon={<TrendingUp size={11} />}
            />
          </div>
        )}

        {/* Per-pipeline breakdown bars */}
        {totals && totals.total_cost_usd > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-text-muted mb-3">
              By pipeline
            </h2>
            <div className="rounded-lg border border-border bg-card p-4 space-y-2.5">
              <PipelineBar label="Coach inference"        cost={totals.coach_cost_usd}        total={totals.total_cost_usd} color="primary" />
              <PipelineBar label="Ingest (Haiku + Voyage)" cost={totals.ingest_cost_usd}       total={totals.total_cost_usd} color="info" />
              <PipelineBar label="Review agent"           cost={totals.review_agent_cost_usd} total={totals.total_cost_usd} color="warning" />
              <PipelineBar label="Eval harness"           cost={totals.eval_cost_usd}         total={totals.total_cost_usd} color="muted" />
            </div>
          </section>
        )}

        {/* Time series */}
        {byDay.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-text-muted mb-3">
              Daily spend
            </h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <CostChart rows={byDay} />
            </div>
          </section>
        )}

        {/* Detail table */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-text-muted mb-3">
            Per pipeline × model
          </h2>
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated border-b border-border">
                <tr className="text-left">
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">Pipeline</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">Provider</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">Model</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Calls</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Input tokens</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Output tokens</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-fg text-sm">No API calls in this window</td></tr>
                ) : summary.map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5 text-fg font-mono text-xs">{r.pipeline}</td>
                    <td className="px-4 py-2.5 text-muted-fg text-xs">{r.provider}</td>
                    <td className="px-4 py-2.5 text-muted-fg font-mono text-xs">{r.model}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-fg">{r.call_count.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-fg">{r.total_input_tokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-fg">{r.total_output_tokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg font-semibold">${r.total_cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function BigStat({
  label, value, sub, accent = false, icon,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className={
      'p-4 rounded-lg border ' +
      (accent ? 'bg-primary-subtle border-primary-muted' : 'bg-card border-border')
    }>
      <div className={'flex items-center gap-1.5 text-[10px] uppercase tracking-widest ' + (accent ? 'text-primary/80' : 'text-text-muted')}>
        {icon}
        <span>{label}</span>
      </div>
      <div className={'text-2xl font-bold tabular-nums mt-2 truncate ' + (accent ? 'text-primary' : 'text-fg')}>
        {value}
      </div>
      {sub && (
        <div className="text-[11px] text-text-muted mt-1 truncate">{sub}</div>
      )}
    </div>
  );
}

function PipelineBar({
  label, cost, total, color,
}: {
  label: string;
  cost: number;
  total: number;
  color: 'primary' | 'info' | 'warning' | 'muted';
}) {
  const pct = total > 0 ? (cost / total) * 100 : 0;
  const barCls =
    color === 'primary' ? 'bg-primary' :
    color === 'info'    ? 'bg-info'    :
    color === 'warning' ? 'bg-warning' :
                          'bg-text-muted';
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-fg w-44 truncate text-xs font-mono">{label}</span>
      <div className="flex-1 h-2 bg-bg-elevated rounded-full overflow-hidden">
        <div className={'h-full ' + barCls} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="text-fg tabular-nums w-20 text-right text-xs font-semibold">
        ${cost.toFixed(2)}
      </span>
      <span className="text-text-muted tabular-nums w-12 text-right text-[10px]">
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}
