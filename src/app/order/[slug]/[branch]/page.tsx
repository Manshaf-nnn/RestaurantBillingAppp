import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { TableEntry } from '@/features/orders/components/table-entry'
import { isOpenNow, parseOpeningHours, todayLabel } from '@/lib/opening-hours'
import { orderableBranches, resolvePublicBranch } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const restaurant = await resolvePublicTenant(slug)
  return {
    title: restaurant ? `Order at ${restaurant.name}` : 'Order',
    description: restaurant?.tagline ?? 'Scan, pick your table and order from your phone.',
  }
}

/**
 * The landing screen for one branch.
 *
 * Everything it needs is in the path, so nothing here depends on a cookie
 * surviving the trip from the QR code.
 */
export default async function BranchEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; branch: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ slug, branch: branchCode }, query] = await Promise.all([params, searchParams])

  const restaurant = await resolvePublicTenant(slug)
  if (!restaurant) notFound()

  const branch = await resolvePublicBranch(restaurant.id, branchCode).catch(() => null)
  if (!branch) notFound()

  const hours = parseOpeningHours(restaurant.openingHours)

  // A table QR carries `?t=`, so the guest types nothing. It is a suggestion
  // only — `resolveTable` still looks it up at THIS branch and refuses one that
  // is not here.
  const table = typeof query.t === 'string' ? query.t : ''

  /*
   * Name the branch whenever there is more than one to be at.
   *
   * The old rule was `!branch.isDefault`, which meant the one case worth
   * catching — silently landing on Main — was the one case that said nothing.
   * A guest who has scanned the wrong card should be able to see it at a
   * glance, and so should an owner testing their own QR codes.
   */
  const orderable = await orderableBranches(restaurant.id)
  const showBranch = orderable.length > 1

  return (
    <TableEntry
      restaurantName={restaurant.name}
      tagline={restaurant.tagline}
      logoUrl={restaurant.logoUrl}
      coverUrl={restaurant.coverUrl}
      city={restaurant.city}
      isOpen={isOpenNow(hours, restaurant.timezone)}
      openingLabel={todayLabel(hours, restaurant.timezone)}
      initialTable={table}
      slug={slug}
      branchCode={branch.code}
      branchName={showBranch ? branch.name : null}
    />
  )
}
