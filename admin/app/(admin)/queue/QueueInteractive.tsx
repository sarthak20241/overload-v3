/**
 * Client-side interactivity for the queue:
 *   - Filter chips (study_design, trust score bucket, source)
 *   - Title search
 *   - Card grid (responsive, 1/2/3 columns)
 *   - Detail side panel with full distillation + Approve/Reject actions
 *   - Keyboard shortcuts: A=approve, R=reject, J/K=next/prev, Esc=close panel
 */
'use client';

import { useState, useMemo, useTransition, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { PendingPaper, ContradictionFlag } from '@/lib/types';
import {
  Search, X, Check, ExternalLink, AlertCircle, ChevronRight,
  AlertTriangle, Replace,
} from 'lucide-react';
import { approvePendingWithSupersede, rejectPending } from './actions';

interface Props {
  papers: PendingPaper[];
}

const STUDY_DESIGN_FILTERS = [
  'meta-analysis', 'systematic-review', 'RCT', 'crossover',
  'cohort', 'observational', 'narrative-review', 'preprint', 'other',
];

const TRUST_BUCKETS = [
  { id: 'high',   label: 'High (≥0.75)',   min: 0.75, max: 1.01 },
  { id: 'mid',    label: 'Mid (0.55–0.74)', min: 0.55, max: 0.75 },
  { id: 'low',    label: 'Low (<0.55)',    min: 0,    max: 0.55 },
] as const;

function trustColor(ts: number): string {
  if (ts >= 0.75) return 'text-primary border-primary-muted bg-primary-subtle';
  if (ts >= 0.55) return 'text-[#a3b900] border-[#a3b90033] bg-[#a3b9001a]';
  if (ts >= 0.40) return 'text-[#d29800] border-[#d2980033] bg-[#d298001a]';
  return 'text-[#c46a4a] border-[#c46a4a33] bg-[#c46a4a1a]';
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

export function QueueInteractive({ papers }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [designFilter, setDesignFilter] = useState<string | null>(null);
  const [trustFilter, setTrustFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Filter + search
  const filtered = useMemo(() => {
    return papers.filter((p) => {
      if (designFilter && p.study_design !== designFilter) return false;
      if (trustFilter) {
        const b = TRUST_BUCKETS.find((x) => x.id === trustFilter);
        if (!b) return false;
        if (p.trust_score < b.min || p.trust_score >= b.max) return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${p.title} ${p.topic_tags.join(' ')} ${p.practical_takeaway}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [papers, search, designFilter, trustFilter]);

  const selected = selectedId ? papers.find((p) => p.id === selectedId) ?? null : null;
  const selectedIdx = selected ? filtered.findIndex((p) => p.id === selected.id) : -1;

  // Auto-dismiss banner
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(t);
  }, [banner]);

  const handleApprove = useCallback((supersedeKbIds: string[]) => {
    if (!selected) return;
    startTransition(async () => {
      const r = await approvePendingWithSupersede(selected.id, supersedeKbIds);
      if (r.ok) {
        setBanner({
          kind: r.partial_errors && r.partial_errors.length > 0 ? 'err' : 'ok',
          text: r.partial_errors && r.partial_errors.length > 0
            ? `${r.message} · failed: ${r.partial_errors.join(', ').slice(0, 200)}`
            : r.message,
        });
        setSelectedId(null);
        router.refresh();
      } else {
        setBanner({ kind: 'err', text: r.error });
      }
    });
  }, [selected, router]);

  const handleReject = useCallback((reason: string) => {
    if (!selected) return;
    startTransition(async () => {
      const r = await rejectPending(selected.id, reason);
      if (r.ok) {
        setBanner({ kind: 'ok', text: r.message });
        setSelectedId(null);
        router.refresh();
      } else {
        setBanner({ kind: 'err', text: r.error });
      }
    });
  }, [selected, router]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape' && selected) { setSelectedId(null); return; }
      if (!selected) return;
      // Keyboard approve = "approve, no supersedes". If the reviewer wants
      // to supersede something, they have to click the toggle + button —
      // intentionally not bound to a hotkey because supersede is destructive.
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); handleApprove([]); }
      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = filtered[Math.min(filtered.length - 1, selectedIdx + 1)];
        if (next) setSelectedId(next.id);
      }
      if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = filtered[Math.max(0, selectedIdx - 1)];
        if (prev) setSelectedId(prev.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, selectedIdx, filtered, handleApprove]);

  return (
    <div className="flex h-full min-h-0">
      {/* Left: list */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Filters */}
        <div className="px-8 py-4 border-b border-border flex flex-col gap-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title, takeaway, or tag…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-md bg-card border border-border focus:border-primary outline-none placeholder:text-text-muted"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              label="all designs"
              active={designFilter === null}
              onClick={() => setDesignFilter(null)}
            />
            {STUDY_DESIGN_FILTERS.map((d) => (
              <FilterChip
                key={d}
                label={d}
                active={designFilter === d}
                onClick={() => setDesignFilter(designFilter === d ? null : d)}
              />
            ))}
            <span className="mx-1 text-text-muted">·</span>
            <FilterChip
              label="all trust"
              active={trustFilter === null}
              onClick={() => setTrustFilter(null)}
            />
            {TRUST_BUCKETS.map((b) => (
              <FilterChip
                key={b.id}
                label={b.label}
                active={trustFilter === b.id}
                onClick={() => setTrustFilter(trustFilter === b.id ? null : b.id)}
              />
            ))}
          </div>
        </div>

        {/* Banner */}
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

        {/* Grid */}
        <div className="flex-1 overflow-y-auto px-8 py-5">
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-3">
            {filtered.length} of {papers.length} pending
          </div>
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
            {filtered.map((p) => (
              <PaperCard
                key={p.id}
                paper={p}
                selected={p.id === selectedId}
                onClick={() => setSelectedId(p.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Right: detail panel */}
      {selected && (
        <DetailPanel
          paper={selected}
          busy={pending}
          onClose={() => setSelectedId(null)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────
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

function PaperCard({
  paper, selected, onClick,
}: { paper: PendingPaper; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'text-left p-4 rounded-lg border transition-colors flex flex-col gap-2 ' +
        (selected
          ? 'border-primary bg-primary-subtle'
          : 'border-border bg-card hover:bg-card-hover hover:border-border-strong')
      }
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={'px-1.5 py-0.5 rounded-md border tabular-nums font-semibold ' + trustColor(paper.trust_score)}>
          {paper.trust_score.toFixed(2)}
        </span>
        <span className="text-text-muted uppercase tracking-wide text-[10px] font-semibold">
          {paper.study_design}
        </span>
        {/*
          Phase 3 contradiction detection: surface a red pill whenever the
          ingest worker flagged this paper as 'contradict' (not
          'different_conditions' — that's noisier and less actionable).
          Reviewer should see at-a-glance that this one needs careful
          attention before approval.
        */}
        {(() => {
          const contradicts = (paper.contradiction_flags ?? []).filter(
            (f) => f.verdict === 'contradict',
          ).length;
          if (contradicts === 0) return null;
          return (
            <span className="px-1.5 py-0.5 rounded-md border border-danger/40 bg-danger/15 text-danger text-[10px] font-bold uppercase tracking-wide">
              {contradicts} conflict{contradicts === 1 ? '' : 's'}
            </span>
          );
        })()}
        <span className="ml-auto text-text-muted">{timeSince(paper.ingested_at)}</span>
      </div>
      <h3 className="text-sm text-fg font-medium leading-snug line-clamp-2">
        {paper.title}
      </h3>
      <p className="text-xs text-muted-fg leading-relaxed line-clamp-2">
        {paper.practical_takeaway}
      </p>
      <div className="flex flex-wrap gap-1 mt-auto">
        {paper.topic_tags.slice(0, 4).map((t) => (
          <span key={t} className="px-1.5 py-0.5 rounded-full bg-bg-elevated text-[10px] text-text-muted">
            {t}
          </span>
        ))}
        {paper.topic_tags.length > 4 && (
          <span className="px-1.5 py-0.5 rounded-full bg-bg-elevated text-[10px] text-text-muted">
            +{paper.topic_tags.length - 4}
          </span>
        )}
      </div>
    </button>
  );
}

function DetailPanel({
  paper, busy, onClose, onApprove, onReject,
}: {
  paper: PendingPaper;
  busy: boolean;
  onClose: () => void;
  onApprove: (supersedeKbIds: string[]) => void;
  onReject: (reason: string) => void;
}) {
  const [rejectMode, setRejectMode] = useState(false);
  const [reason, setReason] = useState('');
  // Phase 3 supersede: reviewer-toggled set of kb_ids the new paper should
  // replace. Empty by default. Reset whenever the panel switches to a new
  // paper so toggles don't leak between reviews.
  const [toggledSupersede, setToggledSupersede] = useState<Set<string>>(new Set());

  useEffect(() => {
    setRejectMode(false);
    setReason('');
    setToggledSupersede(new Set());
  }, [paper.id]);

  const meta = (paper.source_meta ?? {}) as Record<string, unknown>;
  const doi = typeof meta.doi === 'string' ? meta.doi : undefined;
  const pmid = typeof meta.pmid === 'string' ? meta.pmid : undefined;
  const hyde = Array.isArray((meta as any).hyde_questions) ? (meta as any).hyde_questions as string[] : [];
  const flags = paper.contradiction_flags ?? [];

  const toggleSupersede = useCallback((kbId: string) => {
    setToggledSupersede((prev) => {
      const next = new Set(prev);
      if (next.has(kbId)) next.delete(kbId);
      else next.add(kbId);
      return next;
    });
  }, []);

  return (
    <aside className="w-[440px] border-l border-border bg-bg-elevated flex flex-col h-screen">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-fg leading-snug">{paper.title}</h2>
          <p className="text-xs text-muted-fg mt-1.5">
            {paper.authors.slice(0, 3).join(', ')}
            {paper.authors.length > 3 ? ` +${paper.authors.length - 3}` : ''}
            {paper.journal ? ` · ${paper.journal}` : ''}
            {paper.pub_year ? ` · ${paper.pub_year}` : ''}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-card text-text-muted">
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
        {/* Badges */}
        <div className="flex flex-wrap gap-1.5">
          <span className={'px-2 py-1 rounded-md text-xs font-semibold border tabular-nums ' + trustColor(paper.trust_score)}>
            trust {paper.trust_score.toFixed(2)}
          </span>
          <span className="px-2 py-1 rounded-md text-xs border border-border bg-card text-muted-fg">
            {paper.study_design}
          </span>
          <span className="px-2 py-1 rounded-md text-xs border border-border bg-card text-muted-fg">
            {paper.confidence}
          </span>
        </div>

        {/* Source link */}
        {paper.url && (
          <a
            href={paper.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline text-xs"
          >
            <ExternalLink size={11} />
            Open source{doi ? ` (DOI: ${doi.slice(0, 40)})` : pmid ? ` (PMID: ${pmid})` : ''}
          </a>
        )}

        {/*
          Phase 3: Possible Conflicts — surfaced above the distillation so
          the reviewer sees disagreements with existing kb entries FIRST.
          Each flag is a verdict-color-coded card with a "Replace this in KB"
          toggle. Toggling sets are gathered into approvePendingWithSupersede
          on click so promote + supersede happen as one atomic-feeling action.
        */}
        {flags.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-widest text-danger mb-2 flex items-center gap-1.5">
              <AlertTriangle size={11} />
              Possible conflicts ({flags.length})
            </div>
            <div className="space-y-2">
              {flags.map((flag, i) => (
                <ConflictCard
                  key={`${flag.kb_id}-${i}`}
                  flag={flag}
                  toggled={toggledSupersede.has(flag.kb_id)}
                  onToggle={() => toggleSupersede(flag.kb_id)}
                  disabled={busy}
                />
              ))}
            </div>
          </div>
        )}

        <Section label="Population" value={paper.population} />
        <Section label="Intervention" value={paper.intervention} />
        <Section label="Key finding" value={paper.key_finding} highlight />
        <Section label="Practical takeaway" value={paper.practical_takeaway} highlight />

        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">Topics</div>
          <div className="flex flex-wrap gap-1">
            {paper.topic_tags.map((t) => (
              <span key={t} className="px-2 py-0.5 rounded-full bg-card border border-border text-xs text-muted-fg">
                {t}
              </span>
            ))}
          </div>
        </div>

        {hyde.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">
              Questions this answers
            </div>
            <ul className="space-y-1">
              {hyde.map((q, i) => (
                <li key={i} className="text-xs text-muted-fg italic leading-relaxed pl-3 border-l-2 border-border">
                  {q}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-[10px] uppercase tracking-widest text-text-muted">Ingested</div>
        <div className="text-xs text-muted-fg">{timeSince(paper.ingested_at)}</div>
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border space-y-2">
        {rejectMode ? (
          <>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (small-n, irrelevant population, paywall, etc.)"
              className="w-full p-2.5 text-sm rounded-md bg-card border border-border focus:border-danger outline-none placeholder:text-text-muted resize-none"
              rows={2}
              autoFocus
              disabled={busy}
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setRejectMode(false); setReason(''); }}
                disabled={busy}
                className="flex-none px-3 py-2 rounded-md bg-card text-fg text-sm hover:bg-card-hover disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => onReject(reason.trim() || 'no reason given')}
                disabled={busy}
                className="flex-1 px-3 py-2 rounded-md bg-danger text-white text-sm font-semibold hover:bg-danger/90 disabled:opacity-50"
              >
                {busy ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setRejectMode(true)}
              disabled={busy}
              className="flex-none px-3 py-2 rounded-md bg-danger/10 border border-danger/20 text-danger text-sm font-medium hover:bg-danger/15 disabled:opacity-50 flex items-center gap-1.5"
            >
              <X size={13} /> Reject <kbd className="ml-1 text-[10px] opacity-60">R</kbd>
            </button>
            <button
              onClick={() => onApprove(Array.from(toggledSupersede))}
              disabled={busy}
              className="flex-1 px-3 py-2 rounded-md bg-primary text-primary-fg text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <Check size={14} />
              {busy
                ? 'Approving…'
                : toggledSupersede.size > 0
                  ? `Approve + Replace ${toggledSupersede.size}`
                  : 'Approve to KB'}
              {toggledSupersede.size === 0 && (
                <kbd className="text-[10px] opacity-70 ml-1">A</kbd>
              )}
            </button>
          </div>
        )}
        <div className="text-[10px] text-text-muted text-center pt-1">
          J/K navigate · A approve · R reject · Esc close
        </div>
      </div>
    </aside>
  );
}

/**
 * Phase 3 contradiction-card. Shown in the detail panel above the
 * distillation. Each card represents ONE existing kb entry that the
 * ingest pipeline judged as conflicting with the new paper.
 *
 * verdict='contradict'           → red treatment, the high-stakes case
 * verdict='different_conditions' → amber, gentler — papers may both stay
 *
 * The "Replace this in KB" toggle queues this kb_id for supersede on
 * approve. Reviewer can flip multiple at once before clicking Approve;
 * the Approve action will run a server-side promote + supersede chain.
 */
function ConflictCard({
  flag, toggled, onToggle, disabled,
}: {
  flag: ContradictionFlag;
  toggled: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const isContradict = flag.verdict === 'contradict';
  const accent = isContradict
    ? 'border-danger/40 bg-danger/10'
    : 'border-warning/40 bg-warning/10';
  const verdictLabel = isContradict ? 'CONTRADICT' : 'DIFFERENT CONDITIONS';
  const verdictTextColor = isContradict ? 'text-danger' : 'text-warning';

  return (
    <div className={'p-3 rounded-md border ' + accent}>
      <div className="flex items-center gap-2 mb-2">
        <span className={'px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide ' + verdictTextColor + ' bg-bg-elevated border ' + (isContradict ? 'border-danger/30' : 'border-warning/30')}>
          {verdictLabel}
        </span>
        <span className="text-[10px] text-text-muted tabular-nums">
          sim {flag.similarity.toFixed(2)} · conf {flag.confidence.toFixed(2)}
        </span>
      </div>

      <div className="text-xs text-muted-fg mb-1">vs.</div>
      <div className="text-sm text-fg font-medium leading-snug mb-1.5">
        {flag.kb_title}
      </div>
      <blockquote className={'text-xs italic pl-2 border-l-2 leading-relaxed mb-2 ' + (isContradict ? 'border-danger/40' : 'border-warning/40') + ' text-muted-fg'}>
        {flag.kb_finding}
      </blockquote>
      <div className="text-xs text-fg/85 leading-relaxed mb-2">
        {flag.rationale}
      </div>
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
        <div className="text-[10px] text-text-muted">
          {flag.kb_study_design} · trust {flag.kb_trust_score.toFixed(2)}
        </div>
        <button
          onClick={onToggle}
          disabled={disabled}
          className={
            'px-2.5 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-50 ' +
            (toggled
              ? 'bg-primary text-primary-fg'
              : 'bg-card text-fg border border-border hover:border-border-strong')
          }
        >
          <Replace size={11} />
          {toggled ? 'Will replace' : 'Replace in KB'}
        </button>
      </div>
    </div>
  );
}

function Section({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">{label}</div>
      <div className={'text-sm leading-relaxed ' + (highlight ? 'text-fg' : 'text-muted-fg')}>
        {value}
      </div>
    </div>
  );
}
