/**
 * Client-side interactivity for Agent Activity:
 *   - Action-type filter chips
 *   - Smart filters: "needs spot-check" (low-confidence approves),
 *     "downgrades only" (guardrails fired), "reverted only"
 *   - Per-row expand to see full rationale
 *   - Revert button
 */
'use client';

import { useState, useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentReviewLog } from '@/lib/types';
import {
  Check, X, Replace, Repeat, ChevronDown, ChevronUp, RotateCcw,
  AlertTriangle, AlertCircle, Bot,
} from 'lucide-react';
import { revertAgentDecision } from './actions';

const ACTION_CHIPS = [
  { id: 'approve',   label: 'Approves',   color: 'primary' },
  { id: 'reject',    label: 'Rejects',    color: 'danger'  },
  { id: 'supersede', label: 'Supersedes', color: 'warning' },
  { id: 'coexist',   label: 'Coexists',   color: 'info'    },
] as const;

const SMART_FILTERS = [
  { id: 'spot_check',  label: 'Needs spot-check (low confidence approves)' },
  { id: 'downgrades',  label: 'Guardrail downgrades' },
  { id: 'reverted',    label: 'Reverted' },
] as const;

const SPOT_CHECK_CONFIDENCE_THRESHOLD = 0.85;

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function actionChrome(action: AgentReviewLog['final_action']) {
  switch (action) {
    case 'approve':   return { Icon: Check,   label: 'APPROVE',   cls: 'bg-primary-subtle border-primary-muted text-primary' };
    case 'reject':    return { Icon: X,       label: 'REJECT',    cls: 'bg-danger/10 border-danger/30 text-danger' };
    case 'supersede': return { Icon: Replace, label: 'SUPERSEDE', cls: 'bg-warning/10 border-warning/30 text-warning' };
    case 'coexist':   return { Icon: Repeat,  label: 'COEXIST',   cls: 'bg-info/10 border-info/30 text-info' };
  }
}

export function AgentInteractive({ rows }: { rows: AgentReviewLog[] }) {
  const router = useRouter();
  const [actionFilter, setActionFilter] = useState<string | null>(null);
  const [smartFilter, setSmartFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (actionFilter && r.final_action !== actionFilter) return false;
      if (smartFilter === 'spot_check') {
        if (r.final_action !== 'approve') return false;
        if (r.confidence >= SPOT_CHECK_CONFIDENCE_THRESHOLD) return false;
        if (r.reverted_at !== null) return false;
      }
      if (smartFilter === 'downgrades' && r.downgrade_reason === null) return false;
      if (smartFilter === 'reverted' && r.reverted_at === null) return false;
      return true;
    });
  }, [rows, actionFilter, smartFilter]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRevert = (logId: string) => {
    startTransition(async () => {
      try {
        const r = await revertAgentDecision(logId);
        if (r.ok) {
          setBanner({ kind: 'ok', text: r.message });
          router.refresh();
        } else {
          setBanner({ kind: 'err', text: r.error });
        }
      } catch (e) {
        // Server actions can throw (network drop, action runtime panic,
        // Next.js redirect-as-throw). Without this, the spinner clears
        // but no banner appears and the curator has no idea what happened.
        setBanner({
          kind: 'err',
          text: `Failed to revert: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        });
      }
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="px-8 py-4 border-b border-border space-y-2.5">
        <div className="flex flex-wrap gap-1.5">
          <FilterChip
            label="all actions"
            active={actionFilter === null}
            onClick={() => setActionFilter(null)}
          />
          {ACTION_CHIPS.map((a) => (
            <FilterChip
              key={a.id}
              label={a.label}
              active={actionFilter === a.id}
              onClick={() => setActionFilter(actionFilter === a.id ? null : a.id)}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip
            label="all decisions"
            active={smartFilter === null}
            onClick={() => setSmartFilter(null)}
          />
          {SMART_FILTERS.map((f) => (
            <FilterChip
              key={f.id}
              label={f.label}
              active={smartFilter === f.id}
              onClick={() => setSmartFilter(smartFilter === f.id ? null : f.id)}
            />
          ))}
        </div>
      </div>

      {banner && (
        <div className={
          'mx-8 mt-4 p-3 rounded-md border flex items-center gap-2 ' +
          (banner.kind === 'ok'
            ? 'border-primary-muted bg-primary-subtle text-primary'
            : 'border-danger/30 bg-danger/10 text-danger')
        }>
          {banner.kind === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}
          <span className="text-sm">{banner.text}</span>
        </div>
      )}

      {/* Rows */}
      <div className="flex-1 overflow-y-auto px-8 py-5">
        <div className="text-[10px] uppercase tracking-widest text-text-muted mb-3">
          {filtered.length} of {rows.length} decisions
        </div>
        <div className="space-y-2">
          {filtered.map((r) => (
            <AgentRow
              key={r.id}
              row={r}
              expanded={expanded.has(r.id)}
              onToggle={() => toggleExpanded(r.id)}
              onRevert={() => handleRevert(r.id)}
              busy={pending}
            />
          ))}
          {filtered.length === 0 && (
            <div className="text-center text-sm text-muted-fg py-10">
              No decisions match the current filters.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
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

function AgentRow({
  row, expanded, onToggle, onRevert, busy,
}: {
  row: AgentReviewLog;
  expanded: boolean;
  onToggle: () => void;
  onRevert: () => void;
  busy: boolean;
}) {
  const { Icon, label, cls } = actionChrome(row.final_action);
  const isReverted = row.reverted_at !== null;
  const isDowngraded = row.downgrade_reason !== null;
  const lowConfidence = row.final_action === 'approve' && row.confidence < 0.85;

  return (
    <div className={
      'rounded-lg border bg-card p-4 ' +
      (isReverted ? 'opacity-60' : '')
    }>
      <div className="flex items-start gap-3">
        {/* Action chip */}
        <span className={'px-2 py-1 rounded-md border text-[10px] font-bold tracking-wide flex-none flex items-center gap-1 ' + cls}>
          <Icon size={10} />
          {label}
        </span>

        {/* Body */}
        <div className="flex-1 min-w-0">
          {/* Title + meta */}
          <div className="flex items-baseline gap-2 mb-1">
            <h3 className="text-sm text-fg font-medium leading-snug flex-1 truncate">
              {row.paper_title}
            </h3>
            <span className="text-[10px] text-text-muted flex-none">
              {timeSince(row.decided_at)}
            </span>
          </div>

          {/* Inline metadata row */}
          <div className="flex flex-wrap items-center gap-2 mb-2 text-[11px] text-muted-fg">
            <span className="tabular-nums">conf {row.confidence.toFixed(2)}</span>
            {row.flags.map((f) => (
              <span key={f} className="px-1.5 py-0.5 rounded-full bg-bg-elevated text-[10px] text-text-muted">
                {f}
              </span>
            ))}
            {isDowngraded && (
              <span className="px-1.5 py-0.5 rounded-md border border-warning/40 bg-warning/10 text-warning text-[10px] font-semibold flex items-center gap-1">
                <AlertTriangle size={9} />
                Downgraded from {row.proposed_action} by guardrail
              </span>
            )}
            {isReverted && (
              <span className="px-1.5 py-0.5 rounded-md border border-danger/30 bg-danger/10 text-danger text-[10px] font-semibold flex items-center gap-1">
                <RotateCcw size={9} />
                Reverted {row.reverted_by ? `by ${row.reverted_by.slice(0, 12)}…` : ''} {timeSince(row.reverted_at!)}
              </span>
            )}
            {lowConfidence && !isReverted && (
              <span className="px-1.5 py-0.5 rounded-md border border-warning/30 bg-warning/5 text-warning text-[10px] font-medium">
                low confidence — spot-check?
              </span>
            )}
          </div>

          {/* Rationale (truncated + expandable) */}
          <p className={
            'text-xs text-muted-fg leading-relaxed ' +
            (expanded ? '' : 'line-clamp-2')
          }>
            {row.rationale}
          </p>

          {/* Downgrade reason — always shown when present */}
          {isDowngraded && row.downgrade_reason && (
            <p className="text-[11px] text-warning/90 mt-1.5 italic">
              Guardrail: {row.downgrade_reason}
            </p>
          )}

          {/* Superseded IDs — only on expand */}
          {expanded && row.superseded_kb_ids.length > 0 && (
            <div className="mt-2 text-[11px] text-text-muted">
              Superseded {row.superseded_kb_ids.length} kb {row.superseded_kb_ids.length === 1 ? 'entry' : 'entries'}:{' '}
              {row.superseded_kb_ids.map((id) => id.slice(0, 8)).join(', ')}
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border/50">
            <button
              onClick={onToggle}
              className="text-[11px] text-muted-fg hover:text-fg flex items-center gap-1"
            >
              {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {expanded ? 'Collapse' : 'Expand'}
            </button>
            {row.paper_url && (
              <a
                href={row.paper_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-muted-fg hover:text-primary"
              >
                Open paper ↗
              </a>
            )}
            <div className="flex-1" />
            {!isReverted && (
              <button
                onClick={onRevert}
                disabled={busy}
                className="text-[11px] px-2.5 py-1 rounded-md bg-danger/10 border border-danger/30 text-danger hover:bg-danger/15 disabled:opacity-50 flex items-center gap-1 font-medium"
              >
                <RotateCcw size={11} />
                Revert
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
