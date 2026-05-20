/**
 * Tiny stacked time-series chart for the Cost page. SVG-only, no chart-
 * library dependency. Each day becomes a stacked bar by pipeline.
 *
 * Why SVG over Recharts: a single stacked bar chart isn't worth +80 kb of
 * bundle. The whole component is ~120 lines including tooltip / legend.
 */
'use client';

import { useMemo, useState } from 'react';

interface Row {
  day: string;
  bucket: string;
  cost_usd: number;
  call_count: number;
}

const PIPELINE_COLORS: Record<string, string> = {
  coach:          '#c8ff00',  // lime = primary
  ingest_distill: '#60a5fa',  // info blue
  embed_ingest:   '#3b82f6',
  embed_query:    '#1d4ed8',
  review_agent:   '#fbbf24',  // warning amber
  eval_coach:     '#a78bfa',  // muted purple
  eval_judge:     '#7c3aed',
};

function colorFor(bucket: string): string {
  return PIPELINE_COLORS[bucket] ?? '#888';
}

export function CostChart({ rows }: { rows: Row[] }) {
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  // Group rows by day → bucket → cost
  const { days, byDay, buckets, maxDayCost } = useMemo(() => {
    const dayMap = new Map<string, Map<string, number>>();
    const bucketSet = new Set<string>();
    for (const r of rows) {
      bucketSet.add(r.bucket);
      let inner = dayMap.get(r.day);
      if (!inner) {
        inner = new Map<string, number>();
        dayMap.set(r.day, inner);
      }
      inner.set(r.bucket, (inner.get(r.bucket) ?? 0) + r.cost_usd);
    }
    const days = [...dayMap.keys()].sort();
    let maxDayCost = 0;
    for (const [, inner] of dayMap) {
      const sum = [...inner.values()].reduce((a, b) => a + b, 0);
      if (sum > maxDayCost) maxDayCost = sum;
    }
    return { days, byDay: dayMap, buckets: [...bucketSet], maxDayCost };
  }, [rows]);

  if (days.length === 0) return null;

  // Layout
  const width = 100;          // viewBox units — SVG scales to container
  const height = 32;          // aspect-ratio is controlled via the SVG viewBox
  const barGap = 0.3;
  const barWidth = (width / days.length) - barGap;

  const dayTotals = days.map((d) => {
    const inner = byDay.get(d)!;
    return [...inner.values()].reduce((a, b) => a + b, 0);
  });

  return (
    <div>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3 text-[11px]">
        {buckets.map((b) => (
          <span key={b} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colorFor(b) }} />
            <span className="text-muted-fg font-mono">{b}</span>
          </span>
        ))}
      </div>

      {/* Chart */}
      <div className="relative w-full" style={{ aspectRatio: width / height }}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-full">
          {days.map((d, di) => {
            const inner = byDay.get(d)!;
            const x = di * (barWidth + barGap);
            let yOffset = height;
            return (
              <g key={d}>
                {buckets.map((b) => {
                  const v = inner.get(b) ?? 0;
                  if (v === 0) return null;
                  const h = maxDayCost > 0 ? (v / maxDayCost) * height : 0;
                  yOffset -= h;
                  return (
                    <rect
                      key={b}
                      x={x}
                      y={yOffset}
                      width={barWidth}
                      height={h}
                      fill={colorFor(b)}
                      opacity={hoverDay && hoverDay !== d ? 0.35 : 1}
                      onMouseEnter={() => setHoverDay(d)}
                      onMouseLeave={() => setHoverDay(null)}
                      style={{ cursor: 'pointer' }}
                    >
                      <title>{`${d} · ${b}: $${v.toFixed(4)}`}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {/* X-axis labels — only every Nth day to avoid overlap on wide ranges */}
      <div className="flex justify-between mt-2 text-[10px] text-text-muted font-mono">
        {days.map((d, i) => {
          // Only show roughly 5-6 labels regardless of range
          const skip = Math.max(1, Math.floor(days.length / 6));
          if (i % skip !== 0 && i !== days.length - 1) return <span key={d} className="invisible">_</span>;
          return <span key={d}>{d.slice(5)}</span>;  // MM-DD
        })}
      </div>

      {/* Hover summary */}
      {hoverDay && (
        <div className="mt-2 p-2 rounded-md border border-border bg-bg-elevated text-xs">
          <div className="font-semibold text-fg mb-1">{hoverDay}</div>
          <div className="space-y-0.5">
            {buckets.map((b) => {
              const v = byDay.get(hoverDay)?.get(b) ?? 0;
              if (v === 0) return null;
              return (
                <div key={b} className="flex justify-between gap-3">
                  <span className="text-muted-fg font-mono flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: colorFor(b) }} />
                    {b}
                  </span>
                  <span className="text-fg tabular-nums">${v.toFixed(4)}</span>
                </div>
              );
            })}
            <div className="flex justify-between gap-3 pt-1 border-t border-border/60 mt-1">
              <span className="text-text-muted">Total</span>
              <span className="text-fg font-semibold tabular-nums">
                ${dayTotals[days.indexOf(hoverDay)].toFixed(4)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
