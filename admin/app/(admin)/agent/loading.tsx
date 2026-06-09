/**
 * Agent Activity skeleton. Same row-list shape as the queue so it feels
 * consistent across nav, with action-chip slots at the start of each row.
 */
export default function AgentLoading() {
  return (
    <div className="flex flex-col h-screen">
      <div className="px-8 py-5 border-b border-border flex items-center gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="h-6 w-36 bg-card rounded animate-pulse" />
          <div className="h-3 w-48 bg-card rounded animate-pulse opacity-60" />
        </div>
        <div className="ml-auto flex gap-2">
          <div className="h-9 w-24 bg-card rounded-md animate-pulse" />
          <div className="h-9 w-24 bg-card rounded-md animate-pulse" />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden p-6">
        <div className="grid gap-2 max-w-3xl">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card p-4 flex gap-3 animate-pulse"
              style={{ animationDelay: `${i * 70}ms` }}
            >
              {/* Action chip placeholder (approve/reject/supersede) */}
              <div className="h-6 w-20 bg-border rounded-md shrink-0" />
              <div className="flex-1 flex flex-col gap-2">
                <div className="h-4 w-3/4 bg-border rounded" />
                <div className="h-3 w-full bg-border rounded opacity-60" />
                <div className="h-3 w-5/6 bg-border rounded opacity-60" />
                <div className="flex gap-1.5 mt-1">
                  <div className="h-4 w-16 bg-border rounded-full opacity-50" />
                  <div className="h-4 w-14 bg-border rounded-full opacity-50" />
                </div>
              </div>
              <div className="h-8 w-16 bg-border rounded-md opacity-60 self-start" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
