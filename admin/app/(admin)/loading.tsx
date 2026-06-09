/**
 * Default loading skeleton for the (admin) route group.
 *
 * Without this file, every tab switch left the previous page rendered until
 * the new page's server components fully resolved (~400-1300ms) — the UI
 * felt frozen because there was no immediate feedback on click.
 *
 * Next.js App Router uses the nearest `loading.tsx` as a React Suspense
 * boundary fallback. Click /stats → /queue and this skeleton paints
 * INSTANTLY, the new page streams in underneath. Per-route loading.tsx
 * files (queue/loading.tsx, stats/loading.tsx) shadow this one when they
 * exist for shape-matching skeletons; this is the safety net for routes
 * that don't have a custom skeleton yet (agent, conversations, errors,
 * etc.).
 */
export default function AdminLoading() {
  return (
    <div className="flex flex-col h-screen">
      {/* Header strip — same shape as a real page header so the chrome
          doesn't shift around on hand-off. */}
      <div className="px-8 py-5 border-b border-border flex items-center gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="h-5 w-44 bg-card rounded animate-pulse" />
          <div className="h-3 w-32 bg-card rounded animate-pulse opacity-60" />
        </div>
        <div className="ml-auto flex gap-2">
          <div className="h-12 w-24 bg-card rounded-md animate-pulse" />
          <div className="h-12 w-24 bg-card rounded-md animate-pulse" />
          <div className="h-12 w-24 bg-card rounded-md animate-pulse" />
        </div>
      </div>

      {/* Content area: generic vertical list of card-sized blocks. Works
          for the queue list, agent activity list, kb browser — any view
          that's a stack of rows. */}
      <div className="flex-1 min-h-0 overflow-hidden p-8">
        <div className="grid gap-3 max-w-3xl">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-24 bg-card rounded-lg animate-pulse"
              // Stagger the pulse so the skeleton has a subtle rhythm
              // instead of pulsing as one solid block.
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
