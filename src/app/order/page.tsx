import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { MapPin } from 'lucide-react'

import { guestPath } from '@/features/orders/guest-path'
import { orderableBranches } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const restaurant = await resolvePublicTenant()
  return {
    title: restaurant ? `Order at ${restaurant.name}` : 'Order',
    description: restaurant?.tagline ?? 'Scan, pick your table and order from your phone.',
  }
}

/**
 * The old entry point, and the reason this whole class of bug existed.
 *
 * `/order?r=<slug>` carries no branch. It used to fall through to the
 * restaurant's DEFAULT branch and say nothing — so an older printed card, a
 * shared link, or the dashboard's own "Guest menu" shortcut quietly seated
 * every guest at Main. They were then shown Main's tables, and typing a number
 * that only exists at Main got them "table 2 already has an open bill" instead
 * of "that table is not here". Three rounds of fixing the table lookup could
 * not touch it, because the lookup was never what was wrong.
 *
 * It now does one of three things, and never the fourth:
 *
 *   ?b= given          → redirect to the canonical /order/<slug>/<code>
 *   one branch only    → redirect there; a single-site restaurant notices nothing
 *   more than one      → ASK. A page that says "which branch are you at?"
 *
 * What it will not do is guess.
 */
export default async function OrderEntryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  const params = await searchParams
  const branchCode = typeof params.b === 'string' ? params.b.trim() : ''
  const table = typeof params.t === 'string' ? params.t : ''
  const tail = table ? `?t=${encodeURIComponent(table)}` : ''

  const branches = await orderableBranches(restaurant.id)
  if (branches.length === 0) notFound()

  // A card that names its branch goes straight there — old printed QR codes
  // keep working, and land on the canonical URL from now on.
  const named = branchCode
    ? branches.find((b) => b.code.toUpperCase() === branchCode.toUpperCase())
    : null
  if (named) redirect(`${guestPath(restaurant.slug, named.code)}${tail}`)

  // Nothing to choose between.
  if (branches.length === 1) {
    redirect(`${guestPath(restaurant.slug, branches[0].code)}${tail}`)
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-5 py-12">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">{restaurant.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {branchCode
            ? 'That code did not match one of our locations. Which one are you at?'
            : 'Which of our locations are you at?'}
        </p>
      </header>

      <ul className="space-y-2">
        {branches.map((branch) => (
          <li key={branch.id}>
            <Link
              href={`${guestPath(restaurant.slug, branch.code)}${tail}`}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted"
            >
              <MapPin className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{branch.name}</span>
                {branch.address ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {branch.address}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="text-center text-xs text-muted-foreground">
        The QR code on your table takes you straight to the right one.
      </p>
    </main>
  )
}
