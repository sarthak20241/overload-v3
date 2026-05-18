/**
 * Client-side filtering / searching for the KB browser. Server fetches all
 * up to 200 rows in one go; client filters in-memory (small corpus).
 */
'use client';

import { useState, useMemo } from 'react';
import { Search, ExternalLink } from 'lucide-react';
import type { ResearchKbEntry } from '@/lib/types';

function trustColor(ts: number): string {
  if (ts >= 0.75) return 'text-primary border-primary-muted bg-primary-subtle';
  if (ts >= 0.55) return 'text-[#a3b900] border-[#a3b90033] bg-[#a3b9001a]';
  if (ts >= 0.40) return 'text-[#d29800] border-[#d2980033] bg-[#d298001a]';
  return 'text-[#c46a4a] border-[#c46a4a33] bg-[#c46a4a1a]';
}

export function KbInteractive({ entries }: { entries: ResearchKbEntry[] }) {
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // Aggregate the top tags so we have a filter pill row
  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      for (const t of e.topic_tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t]) => t);
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (tagFilter && !e.topic_tags.includes(tagFilter)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${e.title} ${e.practical_takeaway} ${e.key_finding} ${e.topic_tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, search, tagFilter]);

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="px-8 py-4 border-b border-border space-y-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, takeaway, key finding, tag…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-md bg-card border border-border focus:border-primary outline-none placeholder:text-text-muted"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip label="all" active={tagFilter === null} onClick={() => setTagFilter(null)} />
          {topTags.map((t) => (
            <Chip
              key={t}
              label={t}
              active={tagFilter === t}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            />
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-8 py-5">
        <div className="text-[10px] uppercase tracking-widest text-text-muted mb-3">
          {filtered.length} of {entries.length} entries
        </div>
        <div className="space-y-2">
          {filtered.map((e) => (
            <KbRow key={e.id} entry={e} />
          ))}
        </div>
      </div>
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

function KbRow({ entry }: { entry: ResearchKbEntry }) {
  return (
    <div className="p-4 rounded-lg border border-border bg-card hover:bg-card-hover transition-colors">
      <div className="flex items-start gap-3">
        <span className={'px-1.5 py-0.5 rounded-md border tabular-nums font-semibold text-xs flex-none ' + trustColor(entry.trust_score)}>
          {entry.trust_score.toFixed(2)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-text-muted uppercase tracking-wide text-[10px] font-semibold">
              {entry.study_design ?? 'unknown'}
            </span>
            <span className="text-text-muted text-xs">
              {entry.pub_year ?? '—'}{entry.journal ? ` · ${entry.journal}` : ''}
            </span>
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-text-muted hover:text-primary"
                title="Open source"
              >
                <ExternalLink size={12} />
              </a>
            )}
          </div>
          <h3 className="text-sm text-fg font-medium leading-snug mb-1.5">
            {entry.title}
          </h3>
          <p className="text-xs text-muted-fg leading-relaxed mb-2">
            {entry.practical_takeaway}
          </p>
          <div className="flex flex-wrap gap-1">
            {entry.topic_tags.slice(0, 6).map((t) => (
              <span key={t} className="px-1.5 py-0.5 rounded-full bg-bg-elevated text-[10px] text-text-muted">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
