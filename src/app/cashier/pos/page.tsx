import type { Metadata } from 'next'

import { PosTerminal } from '@/features/cashier/components/pos-terminal'
import { getPublicMenu } from '@/features/menu/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'New order' }

const TYPES = new Set(['COUNTER', 'TAKEAWAY', 'DELIVERY'])

export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ORDER_CREATE, '/cashier/pos')
  const restaurant = await requireRestaurant(user.restaurantId)
  const menu = await getPublicMenu(user.restaurantId, restaurant.timezone)

  // Lets the sidebar link straight into takeaway or delivery.
  const params = await searchParams
  const raw = typeof params.type === 'string' ? params.type.toUpperCase() : ''
  const initialType = TYPES.has(raw) ? (raw as 'COUNTER' | 'TAKEAWAY' | 'DELIVERY') : 'COUNTER'

  return (
    <div className="mx-auto w-full max-w-7xl p-4 pb-24 lg:pb-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">New order</h1>
        <p className="text-sm text-muted-foreground">
          Tap a dish to add it. Adjust quantity with − and +.
        </p>
      </header>
      <PosTerminal menu={menu} currency={restaurant.currency} initialType={initialType} />
    </div>
  )
}
