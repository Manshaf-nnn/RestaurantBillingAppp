import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { TableEntry } from '@/features/orders/components/table-entry'
import { isOpenNow, parseOpeningHours, todayLabel } from '@/lib/opening-hours'
import { resolvePublicBranch } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const restaurant = await resolvePublicTenant()
  return {
    title: restaurant ? `Order at ${restaurant.name}` : 'Order',
    description: restaurant?.tagline ?? 'Scan, pick your table and order from your phone.',
  }
}

export default async function OrderEntryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  const params = await searchParams
  const hours = parseOpeningHours(restaurant.openingHours)

  /*
   * A table QR carries `?t=`, so the guest never types anything.
   *
   * The number is only a suggestion here — `resolveTable` looks it up at this
   * branch and refuses one that does not exist there, so a guessed or edited
   * URL cannot seat someone at a table that is not theirs. Pre-filling saves a
   * step for the honest case without weakening the check.
   *
   * That claim was not true until now: `resolveTable` searched by number
   * alone, and since numbers restart per branch it returned an arbitrary
   * table — in practice the main branch's. Both halves are fixed; the code is
   * threaded through explicitly below so the answer does not depend on a
   * cookie surviving the trip.
   */
  const table = typeof params.t === 'string' ? params.t : ''
  const branchCode = typeof params.b === 'string' ? params.b : null
  const branch = await resolvePublicBranch(restaurant.id, branchCode)

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
      // Threaded to `resolveTable` so the table number is looked up at the
      // branch that was scanned, not at whichever one happens to answer first.
      branchCode={branchCode}
      // Named so a guest can see at a glance that they scanned the right code —
      // two branches of the same chain look identical on a phone otherwise.
      branchName={branch && !branch.isDefault ? branch.name : null}
    />
  )
}
