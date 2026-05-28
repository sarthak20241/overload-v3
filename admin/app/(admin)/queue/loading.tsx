/**
 * Queue-specific loading skeleton. Same column proportions as the real
 * QueuePage (header + StatPills row + paper grid) so when the real data
 * lands there's zero layout shift — feels like a real-time refresh
 * rather than a re-render.
 */
export default function QueueLoading() {
  return (
    <div className="flex flex-col h-screen">
      {/* Header — matches QueuePage's header */}
      <div className="px-8 py-5 border-b border-border flex items-center gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="h-6 w-44 bg-card rounded animate-pulse" />
          <div className="h-3 w-40 bg-card rounded animate-pulse opacity-60" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StatPillSkeleton accent />
          <StatPillSkeleton />
          <StatPillSkeleton />
        </div>
      </div>

      {/* Paper grid — staggered pulses for visual rhythm */}
      <div className="flex-1 min-h-0 overflow-hidden p-6">
        <div className="grid gap-2 max-w-3xl">
          {Array.from({ length: 8 }).map((_, i) => (
            <PaperRowSkeleton key={i} index={i} />
          ))}
        </div>
      </div>
    </div>
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
      <div
        className={
          'h-3 w-12 rounded animate-pulse mb-1.5 ' +
          (accent ? 'bg-primary/20' : 'bg-border')
        }
      />
      <div
        className={
          'h-4 w-10 rounded animate-pulse ' +
          (accent ? 'bg-primary/30' : 'bg-border')
        }
      />
    </div>
  );
}

function PaperRowSkeleton({ index }: { index: number }) {
  return (
    <div
      className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2"
      style={{ animationDelay: `${index * 60}ms` }}
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
  );
}
