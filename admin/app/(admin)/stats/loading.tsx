/**
 * Stats-page skeleton. The real stats page renders multiple cards + charts
 * + tables, all blocking on aggregation queries. The skeleton mirrors the
 * column shape so the real content fades in smoothly.
 */
export default function StatsLoading() {
  return (
    <div className="flex flex-col h-screen">
      <div className="px-8 py-5 border-b border-border">
        <div className="h-6 w-36 bg-card rounded animate-pulse mb-1.5" />
        <div className="h-3 w-56 bg-card rounded animate-pulse opacity-60" />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-8">
        {/* KPI tiles row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card p-4"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="h-3 w-20 bg-border rounded animate-pulse opacity-60 mb-2" />
              <div className="h-7 w-16 bg-border rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Big chart placeholder */}
        <div className="rounded-lg border border-border bg-card p-4 mb-4 max-w-4xl">
          <div className="h-4 w-32 bg-border rounded animate-pulse opacity-60 mb-3" />
          <div className="h-48 bg-border rounded animate-pulse opacity-40" />
        </div>

        {/* Two side-by-side card stacks */}
        <div className="grid md:grid-cols-2 gap-4 max-w-4xl">
          {Array.from({ length: 2 }).map((_, col) => (
            <div key={col} className="rounded-lg border border-border bg-card p-4">
              <div className="h-4 w-28 bg-border rounded animate-pulse opacity-60 mb-3" />
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, row) => (
                  <div
                    key={row}
                    className="flex items-center justify-between"
                    style={{ animationDelay: `${(col * 5 + row) * 50}ms` }}
                  >
                    <div className="h-3 w-2/3 bg-border rounded animate-pulse opacity-60" />
                    <div className="h-3 w-12 bg-border rounded animate-pulse opacity-40" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
