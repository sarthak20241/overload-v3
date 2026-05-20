/**
 * Gaps — questions the KB couldn't answer.
 *
 * Pulls coach_traces where retrieval_status='no_matches' OR the
 * citation_ids array is empty. We dedupe on the lowercased preview so
 * "what's the best rep range?" and "What's the best rep range?" collapse
 * into one cluster. Sorted by occurrence count desc.
 *
 * Window is URL-selectable (?since=7d|30d|90d|all). Default 30d so most
 * traffic shows up — 7d hides slower-burning gaps.
 *
 * This is the page that drives Phase 3.5 manual topic ingestion: when a
 * gap cluster passes a threshold (~5+ occurrences from distinct users),
 * the curator runs the ingest worker with that query as a seed term.
 */
import { getSupabaseServerClient } from '@/lib/supabase';
import { Search, AlertCircle, ChevronRight } from 'lucide-react';
import { GapsInteractive, type GapCluster } from './GapsInteractive';

export const dynamic = 'force-dynamic';

type Since = '7d' | '30d' | '90d' | 'all';

function sinceToIso(since: Since): string | null {
  const days = since === '7d' ? 7 : since === '30d' ? 30 : since === '90d' ? 90 : null;
  if (days === null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function loadGaps(since: Since): Promise<{
  clusters: GapCluster[];
  totalGapTurns: number;
  totalUsers: number;
  sampleCap: boolean;
  error: string | null;
}> {
  try {
    const supabase = await getSupabaseServerClient();
    const sinceIso = sinceToIso(since);

    // Pull up to 1000 raw rows in the window. The cap is real: at large
    // sample sizes the page becomes a SQL query, not a triage tool. If
    // the cap bites we surface it in the UI so the curator knows to
    // tighten the window.
    let q = supabase
      .from('coach_traces')
      .select('id, request_at, user_id, last_user_message_preview, retrieval_status, citation_ids, retrieved_doc_ids')
      .or('retrieval_status.eq.no_matches,citation_ids.eq.{}')
      .not('last_user_message_preview', 'is', null)
      .order('request_at', { ascending: false })
      .limit(1000);
    if (sinceIso) q = q.gte('request_at', sinceIso);

    const { data, error } = await q;
    if (error) return { clusters: [], totalGapTurns: 0, totalUsers: 0, sampleCap: false, error: error.message };

    type Row = {
      id: string;
      request_at: string;
      user_id: string | null;
      last_user_message_preview: string | null;
      retrieval_status: string | null;
      citation_ids: string[] | null;
      retrieved_doc_ids: string[] | null;
    };
    const rows = (data ?? []) as Row[];

    const allUsers = new Set<string>();
    // Build with Sets internally so dedupe is cheap, then unwrap to arrays
    // before sending to the client (Set isn't JSON-serializable across the
    // Next.js server→client boundary).
    interface Building {
      key: string; preview: string; count: number;
      last_seen: string; first_seen: string;
      user_ids: Set<string>;
      examples: string[];
      trace_ids: string[];
      reasons: { no_matches: number; no_citations: number };
    }
    const m = new Map<string, Building>();
    for (const r of rows) {
      const preview = (r.last_user_message_preview ?? '').trim();
      if (!preview) continue;
      const key = preview.toLowerCase();
      const uid = r.user_id ? String(r.user_id) : null;
      if (uid) allUsers.add(uid);
      const traceId = String(r.id);
      const reason: 'no_matches' | 'no_citations' =
        r.retrieval_status === 'no_matches' ? 'no_matches' : 'no_citations';

      const existing = m.get(key);
      if (existing) {
        existing.count += 1;
        if (r.request_at > existing.last_seen) existing.last_seen = r.request_at;
        if (r.request_at < existing.first_seen) existing.first_seen = r.request_at;
        if (uid) existing.user_ids.add(uid);
        if (existing.examples.length < 3 && !existing.examples.includes(preview)) {
          existing.examples.push(preview);
        }
        if (existing.trace_ids.length < 5) existing.trace_ids.push(traceId);
        if (reason === 'no_matches') existing.reasons.no_matches += 1;
        else                          existing.reasons.no_citations += 1;
      } else {
        m.set(key, {
          key,
          preview,
          count: 1,
          last_seen: r.request_at,
          first_seen: r.request_at,
          user_ids: new Set(uid ? [uid] : []),
          examples: [preview],
          trace_ids: [traceId],
          reasons: { no_matches: reason === 'no_matches' ? 1 : 0, no_citations: reason === 'no_citations' ? 1 : 0 },
        });
      }
    }

    const clusters: GapCluster[] = [...m.values()]
      .sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen))
      .map((b) => ({
        key: b.key,
        preview: b.preview,
        count: b.count,
        last_seen: b.last_seen,
        first_seen: b.first_seen,
        user_count: b.user_ids.size,
        user_hashes: [...b.user_ids].slice(0, 8).map((u) => u.slice(-5)),
        examples: b.examples,
        trace_ids: b.trace_ids,
        reasons: b.reasons,
      }));

    return {
      clusters,
      totalGapTurns: rows.length,
      totalUsers: allUsers.size,
      sampleCap: rows.length >= 1000,
      error: null,
    };
  } catch (e) {
    return { clusters: [], totalGapTurns: 0, totalUsers: 0, sampleCap: false, error: String(e) };
  }
}

export default async function GapsPage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string }>;
}) {
  const sp = await searchParams;
  const since = (sp.since === '7d' || sp.since === '90d' || sp.since === 'all') ? sp.since as Since : '30d';
  const { clusters, totalGapTurns, totalUsers, sampleCap, error } = await loadGaps(since);

  const windowLabel = since === 'all' ? 'all time' : `last ${since}`;

  return (
    <div className="h-screen overflow-y-auto">
      <div className="px-8 py-5 border-b border-border">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-fg flex items-center gap-2">
              <Search size={18} />
              KB Gaps
            </h1>
            <p className="text-xs text-muted-fg mt-0.5">
              Questions the coach couldn&apos;t answer · {windowLabel} · sample up to 1000 turns
            </p>
          </div>
          <PeriodSelector active={since} />
        </div>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger" />
          <span className="text-sm text-danger">Failed to load: {error}</span>
        </div>
      )}

      <div className="px-8 py-6 space-y-6">
        {/* Headline numbers */}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <Stat label="Gap turns"        value={totalGapTurns} hint="raw coach turns where retrieval missed" />
          <Stat label="Distinct queries" value={clusters.length} hint="deduped on lowercased message preview" />
          <Stat label="Users affected"   value={totalUsers}    hint="distinct user_ids with at least one gap" />
        </div>

        {sampleCap && (
          <div className="p-3 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning flex items-start gap-2">
            <AlertCircle size={13} className="mt-0.5 flex-none" />
            <div>
              <strong>Sample cap reached.</strong> Pulled the most-recent 1000 gap turns
              in this window — counts below are a lower bound. Tighten the window for a
              complete picture.
            </div>
          </div>
        )}

        {clusters.length === 0 && !error ? (
          <div className="rounded-lg border border-border bg-card p-12 text-center">
            <Search size={36} className="text-text-muted mx-auto mb-3" />
            <p className="text-fg font-medium">No retrieval gaps in this window</p>
            <p className="text-sm text-muted-fg mt-1 max-w-md mx-auto">
              Every coach turn found at least one relevant source. Either the KB
              covers the questions being asked, or the coach hasn&apos;t seen
              traffic in this period.
            </p>
          </div>
        ) : (
          <GapsInteractive clusters={clusters} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="p-4 rounded-lg border border-border bg-card">
      <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
      <div className="text-2xl font-bold tabular-nums text-fg mt-1.5">{value.toLocaleString()}</div>
      <div className="text-[10px] text-text-muted mt-1.5">{hint}</div>
    </div>
  );
}

/**
 * Window selector. Links to ?since=... so the page stays a server
 * component — no client state for something as simple as a time range.
 */
function PeriodSelector({ active }: { active: Since }) {
  const options: { value: Since; label: string }[] = [
    { value: '7d',  label: '7d'  },
    { value: '30d', label: '30d' },
    { value: '90d', label: '90d' },
    { value: 'all', label: 'All' },
  ];
  return (
    <div className="flex items-center gap-1 p-0.5 rounded-md border border-border bg-bg-elevated">
      {options.map((o) => {
        const isActive = o.value === active;
        return (
          <a
            key={o.value}
            href={`?since=${o.value}`}
            className={
              'px-3 py-1 rounded text-xs flex items-center gap-1 ' +
              (isActive
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'text-muted-fg hover:text-fg hover:bg-card')
            }
          >
            {o.label}
            {isActive && <ChevronRight size={11} />}
          </a>
        );
      })}
    </div>
  );
}
