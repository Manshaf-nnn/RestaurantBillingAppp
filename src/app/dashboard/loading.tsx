import { SkeletonTable } from '@/components/ui/feedback'

/**
 * What the dashboard shows while a page is being built on the server.
 *
 * Every one of the ~57 dashboard pages is `force-dynamic`, so each one is
 * rendered from scratch on the server for every visit — and until this file
 * existed there was no `loading.tsx` and no `<Suspense>` anywhere beneath
 * `/dashboard`. Next therefore had nothing to show during the wait: the old
 * page stayed frozen on screen, unresponsive, and then the whole thing swapped
 * at once. That reads to anyone using it as the application reloading itself,
 * which is exactly what was reported.
 *
 * The shell — sidebar, header, switcher — is in the layout and stays mounted,
 * so only this region is replaced. Nothing is torn down and no request is
 * re-issued; the difference is that the wait is now visible and the app is
 * plainly still there.
 *
 * Deliberately generic. A per-page skeleton that mirrors each layout exactly
 * would be better still, and would be fifty-seven files to keep in step with
 * the pages they imitate. A header block and a table covers the shape of
 * almost every screen here.
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <div className="mb-6 space-y-2">
        <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-72 animate-pulse rounded-md bg-muted/70" />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-xl border border-border bg-muted/40" />
        ))}
      </div>

      <div className="rounded-xl border border-border p-4">
        <SkeletonTable rows={6} columns={5} />
      </div>
    </div>
  )
}
