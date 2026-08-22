import Link from 'next/link'
import { MapPin } from 'lucide-react'

/**
 * "Which location is this screen for?"
 *
 * ── Why a station cannot show "All locations" ───────────────────────────────
 *
 * The kitchen display, the waiter station and the till are physical screens in
 * physical rooms. `selectedBranch` returns `null` for an owner viewing "All
 * locations", and every one of these pages passed that straight into its query
 * — so an owner opening the kitchen rail saw every branch's tickets at once,
 * and an order placed at Branch 02 appeared on the Main kitchen screen as well
 * as on Branch 02's. That reads, correctly, as the order having been sent to
 * both kitchens.
 *
 * A combined view is meaningful on the dashboard, the orders list and the
 * reports, because those are for reading. It is not meaningful on a rail
 * somebody cooks from: nobody cooks in two buildings. So these screens ask
 * instead of guessing, exactly as the guest's branch chooser does.
 *
 * The choice writes `?branch=`, which `selectedBranch` validates against what
 * this user may reach — so this is a convenience, never a way to widen access.
 */
export function StationBranchPicker({
  title,
  description,
  branches,
  basePath,
}: {
  title: string
  description: string
  branches: Array<{ id: string; name: string }>
  /** e.g. `/kitchen`. The chosen branch is appended as `?branch=<id>`. */
  basePath: string
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-5 py-12">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </header>

      <ul className="space-y-2">
        {branches.map((branch) => (
          <li key={branch.id}>
            <Link
              href={`${basePath}?branch=${encodeURIComponent(branch.id)}`}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 transition-colors hover:bg-muted"
            >
              <MapPin className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{branch.name}</span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="text-center text-xs text-muted-foreground">
        This screen remembers your choice. Staff assigned to a location come
        straight here without being asked.
      </p>
    </main>
  )
}
