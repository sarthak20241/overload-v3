/**
 * Review Queue — server-rendered list of pending papers, with the
 * interactive selection + filtering layer in QueueInteractive (client).
 *
 * Server fetch handles initial render so the queue is up-to-date on every
 * navigation. After approve/reject, the server actions `revalidatePath`
 * here so the list refreshes without a manual reload.
 *
 * Rendering strategy: the page chrome (sidebar, header layout, "Research
 * Review" title) renders synchronously. Stats pills and the paper list
 * each have their OWN <Suspense> boundary so they stream in
 * independently as their Supabase calls resolve. Before this refactor the
 * page did one Promise.all and blocked everything until the slower of
 * the two finished — a 500ms papers query made the 80ms stats query feel
 * like it took 500ms too.
 */
import { Suspense, cache } from 'react';
import { getSupabaseServerClient } from '@/lib/supabase';
import type { PendingPaper, ResearchStats } from '@/lib/types';
import { QueueInteractive } from './QueueInteractive';
import { Inbox, AlertCircle } from 'lucide-react';

export const dynamic = 'force-dynamic';

// React's `cache` dedupes by reference within a single render. Both
// HeaderTextAsync and StatPillsAsync need the same stats payload; without
// this they'd each do their own Supabase roundtrip (2 calls per page load,
// adding ~100-200ms of unnecessary latency on the larger call). With this
// they share ONE network roundtrip and resolve from cache the second time.
//
// Important: this cache is request-scoped. It does NOT persist across
// requests / users / tab switches. Admin gating still works correctly.
const getResearchStats = cache(async (): Promise<ResearchStats | null> => {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.rpc('admin_research_stats').single();
    if (error || !data) return null;
    const raw = data as Record<string, unknown>;
    return {
      pending_count: Number(raw.pending_count ?? 0),
      approved_today: Number(raw.approved_today ?? 0),
      rejected_today: Number(raw.rejected_today ?? 0),
      kb_total: Number(raw.kb_total ?? 0),
      last_cron_at: typeof raw.last_cron_at === 'string' ? raw.last_cron_at : null,
    };
  } catch {
    return null;
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
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

// ── Page shell ──────────────────────────────────────────────────────────────
// Synchronous — paints chrome immediately while the async children stream.
export default function QueuePage() {
  return (
    <div className="flex flex-col h-screen">
      {/* Header row — stats pills are async, header text/title is static */}
      <div className="px-8 py-5 border-b border-border flex items-center gap-6">
        <Suspense fallback={<HeaderTextSkeleton />}>
          <HeaderTextAsync />
        </Suspense>
        <div className="ml-auto flex items-center gap-2">
          <Suspense fallback={<StatPillsSkeleton />}>
            <StatPillsAsync />
          </Suspense>
        </div>
      </div>

      {/* Queue body — streams independently from the header */}
      <div className="flex-1 min-h-0">
        <Suspense fallback={<QueueBodySkeleton />}>
          <QueueBodyAsync />
        </Suspense>
      </div>
    </div>
  );
}

// ── Async sub-components (each owns its own Supabase fetch) ─────────────────
async function HeaderTextAsync() {
  // Pulls via getResearchStats — shared with StatPillsAsync below. Cache
  // means whichever one races first does the RPC; the other gets the
  // cached promise resolution.
  const stats = await getResearchStats();
  return (
    <div>
      <h1 className="text-xl font-semibold text-fg">Research Review</h1>
      <p className="text-xs text-muted-fg mt-0.5">
        Last cron run: {timeSince(stats?.last_cron_at ?? null)}
      </p>
    </div>
  );
}

async function StatPillsAsync() {
  const stats = await getResearchStats();
  if (!stats) {
    return (
      <>
        <StatPill label="Pending" value="—" accent />
        <StatPill label="Today (✓/✗)" value="—" />
        <StatPill label="In KB" value="—" />
      </>
    );
  }
  return (
    <>
      <StatPill label="Pending" value={stats.pending_count} accent />
      <StatPill label="Today (✓/✗)" value={`${stats.approved_today}/${stats.rejected_today}`} />
      <StatPill label="In KB" value={stats.kb_total} />
    </>
  );
}

async function QueueBodyAsync() {
  let papers: PendingPaper[] = [];
  let error: string | null = null;
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error: queryError } = await supabase
      .from('research_kb_pending')
      .select('id, source, url, title, authors, journal, pub_year, pub_date, topic_tags, study_design, confidence, trust_score, population, intervention, key_finding, practical_takeaway, license, ingested_at, review_status, reviewed_at, reviewed_by, rejection_reason, source_meta, contradiction_flags')
      .eq('review_status', 'pending')
      .order('ingested_at', { ascending: true })
      .limit(100);
    if (queryError) {
      error = queryError.message;
    } else {
      papers = (data ?? []).map((p) => ({
        ...p,
        trust_score: Number(p.trust_score),
      })) as PendingPaper[];
    }
  } catch (e) {
    error = String(e);
  }

  if (error) {
    return (
      <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
        <AlertCircle size={14} className="text-danger" />
        <span className="text-sm text-danger">Failed to load: {error}</span>
      </div>
    );
  }

  if (papers.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center gap-3 p-8">
        <Inbox size={36} className="text-text-muted" />
        <div>
          <p className="text-lg text-fg font-medium">Nothing waiting</p>
          <p className="text-sm text-muted-fg mt-1">
            The queue is clear. The cron will land new papers overnight.
          </p>
        </div>
      </div>
    );
  }

  return <QueueInteractive papers={papers} />;
}

// ── Skeletons (Suspense fallbacks) ──────────────────────────────────────────
function HeaderTextSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-6 w-44 bg-card rounded animate-pulse" />
      <div className="h-3 w-40 bg-card rounded animate-pulse opacity-60" />
    </div>
  );
}

function StatPillsSkeleton() {
  return (
    <>
      <StatPillSkeleton accent />
      <StatPillSkeleton />
      <StatPillSkeleton />
    </>
  );
}

function StatPillSkeleton({ accent = false }: { accent?: boolean }) {
  return (
    <div
      className={
        'px-3 py-1.5 rounded-md border w-24 ' +
        (accent
          ? 'bg-primary-subtle border-primary-muted'
          : 'bg-card border-border')
      }
    >
      <div className={'h-3 w-12 rounded animate-pulse mb-1.5 ' + (accent ? 'bg-primary/20' : 'bg-border')} />
      <div className={'h-4 w-10 rounded animate-pulse ' + (accent ? 'bg-primary/30' : 'bg-border')} />
    </div>
  );
}

function QueueBodySkeleton() {
  return (
    <div className="p-6">
      <div className="grid gap-2 max-w-3xl">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="flex items-center gap-2">
              <div className="h-5 w-12 bg-border rounded-full animate-pulse" />
              <div className="h-3 w-20 bg-border rounded animate-pulse opacity-50" />
              <div className="ml-auto h-3 w-16 bg-border rounded animate-pulse opacity-50" />
            </div>
            <div className="h-4 w-3/4 bg-border rounded animate-pulse" />
            <div className="h-3 w-5/6 bg-border rounded animate-pulse opacity-60" />
            <div className="flex gap-1.5 mt-1">
              <div className="h-5 w-16 bg-border rounded-full animate-pulse opacity-60" />
              <div className="h-5 w-14 bg-border rounded-full animate-pulse opacity-60" />
              <div className="h-5 w-20 bg-border rounded-full animate-pulse opacity-60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Static UI ───────────────────────────────────────────────────────────────
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
