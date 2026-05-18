/**
 * Stats — counts, last-cron timestamps per source, top topic distribution.
 *
 * v1 is summary-card based. Charts (papers added over time, rejection
 * reason breakdown) land in a follow-up commit once we have more data and
 * decide on a chart library (probably recharts).
 */
import { getSupabaseServerClient } from '@/lib/supabase';
import type { IngestCheckpoint, ResearchStats } from '@/lib/types';
import { Database, Clock, Inbox, TrendingUp } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface TopicCount { tag: string; count: number; }

async function loadStats(): Promise<{
  stats: ResearchStats | null;
  checkpoints: IngestCheckpoint[];
  topTopics: TopicCount[];
  error: string | null;
}> {
  try {
    const supabase = await getSupabaseServerClient();
    const [statsRes, checkpointsRes, kbRes] = await Promise.all([
      supabase.rpc('admin_research_stats').single(),
      supabase.from('ingest_checkpoints').select('*').order('source'),
      supabase.from('research_kb').select('topic_tags').limit(500),
    ]);

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

    // Aggregate topic distribution from kb sample
    const tagCounts = new Map<string, number>();
    for (const row of (kbRes.data ?? [])) {
      const tags = (row.topic_tags ?? []) as string[];
      for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const topTopics = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag, count]) => ({ tag, count }));

    return { stats, checkpoints, topTopics, error: null };
  } catch (e) {
    return { stats: null, checkpoints: [], topTopics: [], error: String(e) };
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
  const { stats, checkpoints, topTopics, error } = await loadStats();
  const maxTopicCount = topTopics[0]?.count ?? 1;

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
