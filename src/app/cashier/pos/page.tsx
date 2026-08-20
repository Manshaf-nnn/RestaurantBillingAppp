import type { Metadata } from 'next'

import { PosTerminal } from '@/features/cashier/components/pos-terminal'
import { getPublicMenu } from '@/features/menu/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'New order' }

const TYPES = new Set(['COUNTER', 'TAKEAWAY', 'DELIVERY', 'DINE_IN'])

export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ORDER_CREATE, '/cashier/pos')
  const restaurant = await requireRestaurant(user.restaurantId)
  const [menu, tables, servers] = await Promise.all([
    getPublicMenu(user.restaurantId, restaurant.timezone),
    prisma.restaurantTable.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, number: true, area: true, status: true },
      orderBy: { number: 'asc' },
    }),
    // Anyone who works the floor or the till can be credited with a sale.
    prisma.user.findMany({
      where: {
        restaurantId: user.restaurantId, isActive: true, deletedAt: null,
        role: { in: ['WAITER', 'CASHIER', 'MANAGER', 'OWNER', 'ADMIN'] },
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
  ])

  // Lets the sidebar link straight into takeaway or delivery.
  const params = await searchParams
  const raw = typeof params.type === 'string' ? params.type.toUpperCase() : ''
  const initialType = TYPES.has(raw)
    ? (raw as 'COUNTER' | 'TAKEAWAY' | 'DELIVERY' | 'DINE_IN')
    : 'COUNTER'

  return (
    <div className="mx-auto w-full max-w-7xl p-4 pb-24 lg:pb-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">New order</h1>
        <p className="text-sm text-muted-foreground">
          Tap a dish to add it. Adjust quantity with − and +.
        </p>
      </header>
      <PosTerminal
        menu={menu}
        currency={restaurant.currency}
        initialType={initialType}
        tables={tables.map((t) => ({ ...t, status: t.status as string }))}
        servers={servers.map((s) => ({ ...s, role: s.role as string }))}
        currentUserId={user.id}
      />
    </div>
  )
}
