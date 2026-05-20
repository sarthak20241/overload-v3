/**
 * Review Queue — server-rendered list of pending papers, with the
 * interactive selection + filtering layer in QueueInteractive (client).
 *
 * Server fetch handles initial render so the queue is up-to-date on every
 * navigation. After approve/reject, the server actions `revalidatePath`
 * here so the list refreshes without a manual reload.
 */
import { getSupabaseServerClient } from '@/lib/supabase';
import type { PendingPaper, ResearchStats } from '@/lib/types';
import { QueueInteractive } from './QueueInteractive';
import { Inbox, AlertCircle } from 'lucide-react';

export const dynamic = 'force-dynamic';

async function loadQueue(): Promise<{ papers: PendingPaper[]; stats: ResearchStats | null; error: string | null }> {
  try {
    const supabase = await getSupabaseServerClient();
    const [papersRes, statsRes] = await Promise.all([
      supabase
        .from('research_kb_pending')
        .select('id, source, url, title, authors, journal, pub_year, pub_date, topic_tags, study_design, confidence, trust_score, population, intervention, key_finding, practical_takeaway, license, ingested_at, review_status, reviewed_at, reviewed_by, rejection_reason, source_meta, contradiction_flags')
        .eq('review_status', 'pending')
        .order('ingested_at', { ascending: true })
        .limit(100),
      supabase.rpc('admin_research_stats').single(),
    ]);
    const papers = (papersRes.data ?? []).map((p) => ({
      ...p,
      trust_score: Number(p.trust_score),
    })) as PendingPaper[];
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
    return { papers, stats, error: null };
  } catch (e) {
    return { papers: [], stats: null, error: String(e) };
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

export default async function QueuePage() {
  const { papers, stats, error } = await loadQueue();

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="px-8 py-5 border-b border-border flex items-center gap-6">
        <div>
          <h1 className="text-xl font-semibold text-fg">Research Review</h1>
          <p className="text-xs text-muted-fg mt-0.5">
            Last cron run: {timeSince(stats?.last_cron_at ?? null)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StatPill label="Pending" value={stats?.pending_count ?? 0} accent />
          <StatPill label="Today (✓/✗)" value={`${stats?.approved_today ?? 0}/${stats?.rejected_today ?? 0}`} />
          <StatPill label="In KB" value={stats?.kb_total ?? 0} />
        </div>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger" />
          <span className="text-sm text-danger">Failed to load: {error}</span>
        </div>
      )}

      {/* Queue */}
      <div className="flex-1 min-h-0">
        {papers.length === 0 && !error ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 p-8">
            <Inbox size={36} className="text-text-muted" />
            <div>
              <p className="text-lg text-fg font-medium">Nothing waiting</p>
              <p className="text-sm text-muted-fg mt-1">
                The queue is clear. The cron will land new papers overnight.
              </p>
            </div>
          </div>
        ) : (
          <QueueInteractive papers={papers} />
        )}
      </div>
    </div>
  );
}

function StatPill({ label, value, accent = false }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={
      'px-3 py-1.5 rounded-md border ' +
      (accent
        ? 'bg-primary-subtle border-primary-muted'
        : 'bg-card border-border')
    }>
      <div className={'text-xs ' + (accent ? 'text-primary/80' : 'text-text-muted')}>{label}</div>
      <div className={'text-sm font-semibold tabular-nums ' + (accent ? 'text-primary' : 'text-fg')}>
        {value}
      </div>
    </div>
  );
}
