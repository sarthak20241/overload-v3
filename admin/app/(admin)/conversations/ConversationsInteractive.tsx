/**
 * Conversations interactive view.
 *
 * Left side: filterable + searchable list of recent coach turns.
 * Right side: detail panel with the full trace, retrieved docs,
 * citations, tool calls, and token usage.
 *
 * Filters:
 *   - status: all / success / error
 *   - retrieval status: all / ok / no_matches / skipped_no_voyage_key / failed
 *   - has citations / has retrieval / has tool calls
 *   - free-text search across user message + response preview
 */
'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  Search, X, ExternalLink, Check, AlertCircle, Clock, Hash, BookOpen, Cpu,
} from 'lucide-react';

export interface CoachTrace {
  id: string;
  request_at: string;
  user_id: string | null;
  status: string;
  http_status: number;
  error_message: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  latency_ms: number | null;
  message_count: number | null;
  has_user_context: boolean | null;
  retrieved_doc_ids: string[];
  retrieval_status: string | null;
  citation_ids: string[];
  tool_calls: string[];
  last_user_message_preview: string | null;
  response_preview: string | null;
}

function shortHash(s: string | null): string {
  if (!s) return 'anon';
  // user_2x...wgL6d → wgL6d
  return s.slice(-5);
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

const STATUS_FILTERS = [
  { id: 'all',     label: 'All' },
  { id: 'success', label: 'Success' },
  { id: 'error',   label: 'Errors' },
] as const;

export function ConversationsInteractive({
  traces,
  initialUserFilter = null,
  initialSelectedId  = null,
}: {
  traces: CoachTrace[];
  /** From `/conversations?user=<hash>` — last-5 hash of a Clerk user_id.
   *  Matches the internal shortHash buckets so the /users page link
   *  pre-applies the filter on landing. */
  initialUserFilter?: string | null;
  /** From `/conversations?trace=<traceId>` — opens the side panel on
   *  the matching trace if it's in the loaded window. From /gaps deep
   *  links. */
  initialSelectedId?: string | null;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all');
  const [retrievalFilter, setRetrievalFilter] = useState<string | null>(null);
  const [hasCitations, setHasCitations] = useState<boolean | null>(null);
  const [userFilter, setUserFilter] = useState<string | null>(initialUserFilter);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);

  // Distinct retrieval-status values for filter pills
  const retrievalStatuses = useMemo(() => {
    const s = new Set<string>();
    for (const t of traces) if (t.retrieval_status) s.add(t.retrieval_status);
    return [...s];
  }, [traces]);

  // Distinct user_ids — short-hash buckets for the user filter row
  const userBuckets = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of traces) {
      if (!t.user_id) continue;
      const k = shortHash(t.user_id);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [traces]);

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (statusFilter === 'success' && t.status !== 'success') return false;
      if (statusFilter === 'error'   && t.status === 'success') return false;
      if (retrievalFilter && t.retrieval_status !== retrievalFilter) return false;
      if (hasCitations === true  && t.citation_ids.length === 0) return false;
      if (hasCitations === false && t.citation_ids.length > 0)  return false;
      if (userFilter && shortHash(t.user_id) !== userFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${t.last_user_message_preview ?? ''} ${t.response_preview ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [traces, statusFilter, retrievalFilter, hasCitations, userFilter, search]);

  const selected = selectedId ? traces.find((t) => t.id === selectedId) ?? null : null;

  useEffect(() => {
    if (selectedId && !traces.find((t) => t.id === selectedId)) setSelectedId(null);
  }, [traces, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Filters */}
        <div className="px-8 py-4 border-b border-border space-y-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search user message or response…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-md bg-card border border-border focus:border-primary outline-none placeholder:text-text-muted"
            />
          </div>
          <div className="flex flex-wrap gap-1.5 items-center">
            {STATUS_FILTERS.map((f) => (
              <Chip
                key={f.id}
                label={f.label}
                active={statusFilter === f.id}
                onClick={() => setStatusFilter(f.id as typeof statusFilter)}
              />
            ))}
            <span className="mx-1 text-text-muted">·</span>
            <Chip label="any retrieval" active={retrievalFilter === null} onClick={() => setRetrievalFilter(null)} />
            {retrievalStatuses.map((s) => (
              <Chip key={s} label={s} active={retrievalFilter === s} onClick={() => setRetrievalFilter(retrievalFilter === s ? null : s)} />
            ))}
            <span className="mx-1 text-text-muted">·</span>
            <Chip label="any citations" active={hasCitations === null} onClick={() => setHasCitations(null)} />
            <Chip label="with citations" active={hasCitations === true} onClick={() => setHasCitations(hasCitations === true ? null : true)} />
            <Chip label="no citations" active={hasCitations === false} onClick={() => setHasCitations(hasCitations === false ? null : false)} />
          </div>
          {userBuckets.length > 1 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] uppercase tracking-widest text-text-muted">Users</span>
              <Chip label="all" active={userFilter === null} onClick={() => setUserFilter(null)} />
              {userBuckets.map(([u, n]) => (
                <Chip key={u} label={`${u} (${n})`} active={userFilter === u} onClick={() => setUserFilter(userFilter === u ? null : u)} />
              ))}
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-8 py-3 text-[10px] uppercase tracking-widest text-text-muted">
            {filtered.length} of {traces.length} turns
          </div>
          <div className="divide-y divide-border/60">
            {filtered.map((t) => (
              <TraceRow
                key={t.id}
                trace={t}
                selected={t.id === selectedId}
                onClick={() => setSelectedId(t.id === selectedId ? null : t.id)}
              />
            ))}
            {filtered.length === 0 && (
              <div className="text-center text-sm text-muted-fg py-12">
                No turns match the current filters.
              </div>
            )}
          </div>
        </div>
      </div>

      {selected && (
        <ConversationDetail trace={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-1 rounded-full text-xs transition-colors ' +
        (active
          ? 'bg-primary text-primary-fg font-medium'
          : 'bg-card text-muted-fg border border-border hover:text-fg hover:border-border-strong')
      }
    >
      {label}
    </button>
  );
}

function TraceRow({
  trace, selected, onClick,
}: { trace: CoachTrace; selected: boolean; onClick: () => void }) {
  const isError = trace.status !== 'success';
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-8 py-3 transition-colors block ' +
        (selected ? 'bg-primary-subtle' : 'hover:bg-card-hover')
      }
    >
      <div className="flex items-start gap-3">
        {/* Status icon */}
        <div className="flex-none w-5 h-5 mt-0.5 flex items-center justify-center">
          {isError ? (
            <AlertCircle size={14} className="text-danger" />
          ) : (
            <Check size={14} className="text-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[10px] font-mono text-text-muted">{shortHash(trace.user_id)}</span>
            <span className="text-[10px] text-text-muted">·</span>
            <span className="text-[10px] text-text-muted">{timeSince(trace.request_at)}</span>
            {trace.latency_ms !== null && (
              <>
                <span className="text-[10px] text-text-muted">·</span>
                <span className="text-[10px] text-text-muted tabular-nums">
                  {(trace.latency_ms / 1000).toFixed(1)}s
                </span>
              </>
            )}
            {trace.retrieval_status && (
              <>
                <span className="text-[10px] text-text-muted">·</span>
                <span className={
                  'text-[10px] tabular-nums ' +
                  (trace.retrieval_status === 'ok' ? 'text-primary' : 'text-warning')
                }>
                  {trace.retrieval_status}
                </span>
              </>
            )}
            {trace.citation_ids.length > 0 && (
              <span className="text-[10px] text-muted-fg flex items-center gap-0.5">
                <BookOpen size={9} />
                {trace.citation_ids.length}
              </span>
            )}
            {trace.tool_calls.length > 0 && (
              <span className="text-[10px] text-muted-fg flex items-center gap-0.5">
                <Cpu size={9} />
                {trace.tool_calls.length}
              </span>
            )}
          </div>
          {trace.last_user_message_preview && (
            <p className="text-sm text-fg leading-snug line-clamp-2">
              {trace.last_user_message_preview}
            </p>
          )}
          {trace.response_preview && (
            <p className="text-xs text-muted-fg leading-relaxed line-clamp-2 mt-1">
              {trace.response_preview}
            </p>
          )}
          {isError && trace.error_message && (
            <p className="text-xs text-danger mt-1 italic">{trace.error_message}</p>
          )}
        </div>
      </div>
    </button>
  );
}

function ConversationDetail({ trace, onClose }: { trace: CoachTrace; onClose: () => void }) {
  const isError = trace.status !== 'success';
  const totalTokens = (trace.input_tokens ?? 0) + (trace.output_tokens ?? 0);
  const cacheHitRate =
    trace.input_tokens && trace.cache_read_input_tokens
      ? (trace.cache_read_input_tokens / trace.input_tokens) * 100
      : null;

  return (
    <aside className="w-[460px] border-l border-border bg-bg-elevated flex flex-col h-screen overflow-y-auto">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={
              'px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ' +
              (isError
                ? 'bg-danger/15 border border-danger/30 text-danger'
                : 'bg-primary-subtle border border-primary-muted text-primary')
            }>
              {trace.status}
            </span>
            <span className="text-[10px] text-text-muted tabular-nums">HTTP {trace.http_status}</span>
            <span className="text-[10px] text-text-muted">·</span>
            <span className="text-[10px] text-text-muted">{timeSince(trace.request_at)}</span>
          </div>
          <p className="text-xs text-muted-fg font-mono">
            user: {trace.user_id ?? 'anonymous'}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-card text-text-muted">
          <X size={14} />
        </button>
      </div>

      <div className="p-5 space-y-4 text-sm">
        {/* Error */}
        {isError && trace.error_message && (
          <section>
            <div className="text-[10px] uppercase tracking-widest text-danger mb-1.5 flex items-center gap-1.5">
              <AlertCircle size={11} /> Error
            </div>
            <div className="p-3 rounded-md border border-danger/30 bg-danger/10 text-sm text-danger font-mono break-all">
              {trace.error_message}
            </div>
          </section>
        )}

        {/* User message */}
        {trace.last_user_message_preview && (
          <section>
            <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">
              User message (preview, first 200 chars)
            </div>
            <div className="p-3 rounded-md bg-card border border-border text-sm text-fg leading-relaxed">
              {trace.last_user_message_preview}
            </div>
          </section>
        )}

        {/* Response */}
        {trace.response_preview && (
          <section>
            <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">
              Response (preview)
            </div>
            <div className="p-3 rounded-md bg-card border border-border text-sm text-muted-fg leading-relaxed whitespace-pre-wrap">
              {trace.response_preview}
            </div>
          </section>
        )}

        {/* Metrics */}
        <section>
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">Metrics</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Metric icon={<Clock size={11} />}    label="Latency"  value={trace.latency_ms !== null ? `${(trace.latency_ms / 1000).toFixed(2)}s` : '—'} />
            <Metric icon={<Hash size={11} />}     label="Messages" value={trace.message_count?.toString() ?? '—'} />
            <Metric icon={<Cpu size={11} />}      label="Tools"    value={trace.tool_calls.length.toString()} />
            <Metric icon={<BookOpen size={11} />} label="Citations" value={trace.citation_ids.length.toString()} />
            <Metric label="Input tokens"  value={trace.input_tokens?.toLocaleString() ?? '—'} />
            <Metric label="Output tokens" value={trace.output_tokens?.toLocaleString() ?? '—'} />
            <Metric label="Cache read"    value={trace.cache_read_input_tokens?.toLocaleString() ?? '—'} />
            <Metric label="Cache write"   value={trace.cache_creation_input_tokens?.toLocaleString() ?? '—'} />
          </div>
          {cacheHitRate !== null && (
            <div className="mt-2 text-[11px] text-muted-fg">
              Cache hit rate: <span className="text-fg tabular-nums">{cacheHitRate.toFixed(0)}%</span>
              {' '}of input tokens served from cache.
            </div>
          )}
        </section>

        {/* Retrieval */}
        <section>
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">Retrieval</div>
          <div className="text-xs text-muted-fg">
            Status: <span className={
              'tabular-nums ' +
              (trace.retrieval_status === 'ok' ? 'text-primary' : 'text-warning')
            }>{trace.retrieval_status ?? 'unknown'}</span>
          </div>
          {trace.retrieved_doc_ids.length > 0 && (
            <div className="mt-1.5">
              <div className="text-[10px] text-text-muted mb-1">Retrieved KB entries</div>
              <ul className="text-[11px] font-mono text-muted-fg space-y-0.5">
                {trace.retrieved_doc_ids.map((id) => (
                  <li key={id} className="flex items-center justify-between">
                    <span>{id.slice(0, 13)}…</span>
                    {trace.citation_ids.includes(id) && (
                      <span className="text-primary text-[10px] flex items-center gap-0.5">
                        <BookOpen size={9} /> cited
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Tool calls */}
        {trace.tool_calls.length > 0 && (
          <section>
            <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">Tool calls</div>
            <div className="flex flex-wrap gap-1">
              {trace.tool_calls.map((tc, i) => (
                <span key={i} className="px-2 py-0.5 rounded-full bg-card border border-border text-[11px] text-muted-fg font-mono">
                  {tc}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Model + total */}
        <section className="text-[11px] text-text-muted pt-2 border-t border-border/60">
          <div>Model: <span className="text-fg font-mono">{trace.model ?? 'unknown'}</span></div>
          <div>Total tokens: <span className="text-fg tabular-nums">{totalTokens.toLocaleString()}</span></div>
          <div>has_user_context: <span className="text-fg">{trace.has_user_context === true ? 'yes' : trace.has_user_context === false ? 'no' : '—'}</span></div>
        </section>
      </div>
    </aside>
  );
}

function Metric({
  icon, label, value,
}: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="px-2.5 py-1.5 rounded-md bg-card border border-border">
      <div className="text-[10px] text-text-muted flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-sm text-fg font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
