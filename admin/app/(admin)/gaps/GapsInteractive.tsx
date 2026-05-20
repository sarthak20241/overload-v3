/**
 * GapsInteractive — client-side filter, search, and detail panel for
 * KB gap clusters.
 *
 * Server pre-aggregates and sorts. This layer does:
 *   1. Free-text search across the preview.
 *   2. Min-occurrence filter (default 1 — every gap is signal, but the
 *      curator usually wants ≥2 to weed out one-off typos).
 *   3. Min-distinct-users filter — a gap with 8 occurrences from one
 *      user is less interesting than 3 occurrences from 3 different
 *      users.
 *   4. Side-panel detail with examples, reasons, sample traces, and
 *      copy-as-seed-term action.
 */
'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, X, Copy, Check, AlertCircle, ChevronRight, Users, Clock, FileQuestion } from 'lucide-react';

export interface GapCluster {
  key: string;
  preview: string;
  count: number;
  last_seen: string;
  first_seen: string;
  user_count: number;
  /** Last-5 hashes of distinct user IDs, used to render anonymized chips */
  user_hashes: string[];
  /** Up to 3 distinct preview variants (case-different originals) */
  examples: string[];
  /** Up to 5 sample trace IDs for click-through to /conversations */
  trace_ids: string[];
  reasons: { no_matches: number; no_citations: number };
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

export function GapsInteractive({ clusters }: { clusters: GapCluster[] }) {
  const [search, setSearch] = useState('');
  const [minOccur, setMinOccur] = useState<1 | 2 | 5>(1);
  const [minUsers, setMinUsers] = useState<1 | 2>(1);
  const [selected, setSelected] = useState<GapCluster | null>(null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return clusters.filter((c) =>
      c.count >= minOccur &&
      c.user_count >= minUsers &&
      (!needle || c.key.includes(needle))
    );
  }, [clusters, search, minOccur, minUsers]);

  const maxCount = filtered[0]?.count ?? 1;

  return (
    <div className="flex gap-6 min-h-0">
      <div className="flex-1 min-w-0 space-y-4">
        {/* Filter bar */}
        <div className="rounded-lg border border-border bg-card p-3 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search query text…"
              className="w-full pl-9 pr-8 py-1.5 text-sm bg-bg-elevated border border-border rounded-md text-fg placeholder:text-text-muted focus:outline-none focus:border-primary/50"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-fg"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <FilterPills
            label="Min occur"
            value={minOccur}
            options={[1, 2, 5]}
            onChange={(v) => setMinOccur(v as 1 | 2 | 5)}
          />
          <FilterPills
            label="Min users"
            value={minUsers}
            options={[1, 2]}
            onChange={(v) => setMinUsers(v as 1 | 2)}
          />
          <span className="text-xs text-muted-fg tabular-nums ml-auto">
            {filtered.length} / {clusters.length} clusters
          </span>
        </div>

        {/* Cluster list */}
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-fg text-sm">
            No clusters match the current filters.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card divide-y divide-border/60">
            {filtered.map((c, i) => (
              <ClusterRow
                key={c.key}
                rank={i + 1}
                cluster={c}
                maxCount={maxCount}
                active={selected?.key === c.key}
                onClick={() => setSelected(c)}
              />
            ))}
          </div>
        )}
      </div>

      {selected && (
        <DetailPanel cluster={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function FilterPills({
  label, value, options, onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-widest text-text-muted">{label}</span>
      <div className="flex p-0.5 rounded-md border border-border bg-bg-elevated">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={
              'px-2 py-0.5 rounded text-xs tabular-nums ' +
              (o === value
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'text-muted-fg hover:text-fg')
            }
          >
            {o}+
          </button>
        ))}
      </div>
    </div>
  );
}

function ClusterRow({
  rank, cluster, maxCount, active, onClick,
}: {
  rank: number;
  cluster: GapCluster;
  maxCount: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left p-4 flex items-start gap-3 transition-colors ' +
        (active ? 'bg-primary-subtle/40' : 'hover:bg-card-hover')
      }
    >
      <span className="text-text-muted tabular-nums w-6 text-right text-xs font-mono mt-0.5">
        #{rank}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg leading-snug line-clamp-2">{cluster.preview}</p>
        <div className="flex items-center gap-3 mt-1.5 text-[10px] text-text-muted">
          <span className="flex items-center gap-1 tabular-nums">
            <FileQuestion size={10} />
            ×{cluster.count}
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <Users size={10} />
            {cluster.user_count} user{cluster.user_count === 1 ? '' : 's'}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {timeSince(cluster.last_seen)}
          </span>
          {cluster.reasons.no_matches > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-danger/10 text-danger text-[9px] font-semibold uppercase tracking-wide">
              {cluster.reasons.no_matches} no-match
            </span>
          )}
          {cluster.reasons.no_citations > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-warning/10 text-warning text-[9px] font-semibold uppercase tracking-wide">
              {cluster.reasons.no_citations} no-cite
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-none mt-2">
        <div className="w-20 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full bg-warning"
            style={{ width: `${(cluster.count / maxCount) * 100}%` }}
          />
        </div>
        <ChevronRight size={14} className="text-text-muted" />
      </div>
    </button>
  );
}

function DetailPanel({ cluster, onClose }: { cluster: GapCluster; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(cluster.preview).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <aside className="w-[26rem] flex-none border border-border bg-card rounded-lg p-5 self-start sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 text-text-muted text-[10px] uppercase tracking-widest">
          <FileQuestion size={11} />
          Gap cluster
        </div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-fg p-0.5"
        >
          <X size={15} />
        </button>
      </div>

      <p className="text-sm text-fg leading-snug mb-4">{cluster.preview}</p>

      <div className="grid grid-cols-3 gap-2 text-center mb-5">
        <Metric value={cluster.count} label="occurrences" />
        <Metric value={cluster.user_count} label="distinct users" />
        <Metric value={cluster.trace_ids.length} label="sample traces" />
      </div>

      <button
        onClick={copy}
        className="w-full mb-5 px-3 py-2 rounded-md border border-primary-muted bg-primary-subtle text-primary text-xs font-semibold hover:bg-primary-subtle/80 flex items-center justify-center gap-1.5"
      >
        {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy as seed term</>}
      </button>

      <Section title="Window">
        <div className="text-xs text-muted-fg space-y-0.5">
          <div>First seen: {timeSince(cluster.first_seen)}</div>
          <div>Last seen: {timeSince(cluster.last_seen)}</div>
        </div>
      </Section>

      <Section title="Why retrieval missed">
        <div className="space-y-1.5 text-xs">
          {cluster.reasons.no_matches > 0 && (
            <ReasonRow
              count={cluster.reasons.no_matches}
              total={cluster.count}
              label="No vector matches"
              hint="The user's query embedded outside any KB neighborhood — we have nothing on this topic at all."
              color="danger"
            />
          )}
          {cluster.reasons.no_citations > 0 && (
            <ReasonRow
              count={cluster.reasons.no_citations}
              total={cluster.count}
              label="No citations rendered"
              hint="The coach pulled neighbors but didn't end up citing any — either the model judged them irrelevant, or retrieval landed in the wrong topic."
              color="warning"
            />
          )}
        </div>
      </Section>

      {cluster.examples.length > 1 && (
        <Section title={`Variants (${cluster.examples.length})`}>
          <ul className="space-y-1 text-xs text-muted-fg">
            {cluster.examples.map((e, i) => (
              <li key={i} className="leading-snug border-l-2 border-border pl-2">{e}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Affected users (${cluster.user_count})`}>
        <div className="flex flex-wrap gap-1">
          {cluster.user_hashes.map((u) => (
            <Link
              key={u}
              href={`/users`}
              className="px-1.5 py-0.5 rounded bg-bg-elevated border border-border text-[10px] font-mono text-muted-fg hover:text-fg hover:border-primary/30"
              title={`User ending in ${u}`}
            >
              …{u}
            </Link>
          ))}
          {cluster.user_count > cluster.user_hashes.length && (
            <span className="px-1.5 py-0.5 text-[10px] text-text-muted">
              +{cluster.user_count - cluster.user_hashes.length} more
            </span>
          )}
        </div>
      </Section>

      <Section title={`Sample traces (${cluster.trace_ids.length})`}>
        <ul className="space-y-1 text-xs">
          {cluster.trace_ids.map((id) => (
            <li key={id}>
              <Link
                href={`/conversations#${id}`}
                className="text-primary hover:underline font-mono text-[11px] flex items-center gap-1"
              >
                {id.slice(0, 8)}… <ChevronRight size={11} />
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <div className="mt-5 pt-3 border-t border-border/60 flex items-start gap-2 text-[11px] text-text-muted">
        <AlertCircle size={12} className="mt-0.5 flex-none" />
        <p>
          Copy this query as a seed term and feed it into the ingest worker
          (<code className="font-mono">tools/research-ingest</code>) to pull
          papers Haiku can distill into KB entries.
        </p>
      </div>
    </aside>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="p-2 rounded-md border border-border bg-bg-elevated">
      <div className="text-lg font-bold tabular-nums text-fg">{value.toLocaleString()}</div>
      <div className="text-[9px] uppercase tracking-widest text-text-muted">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function ReasonRow({
  count, total, label, hint, color,
}: {
  count: number;
  total: number;
  label: string;
  hint: string;
  color: 'danger' | 'warning';
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const dotCls = color === 'danger' ? 'bg-danger' : 'bg-warning';
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-fg flex items-center gap-1.5">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotCls}`} />
          {label}
        </span>
        <span className="text-muted-fg tabular-nums">{count} ({pct.toFixed(0)}%)</span>
      </div>
      <p className="text-[10px] text-text-muted leading-snug ml-3">{hint}</p>
    </div>
  );
}
