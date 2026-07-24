import type { Metadata } from 'next'

import { PurchasesManager } from '@/features/inventory/components/purchases-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Purchases' }

export default async function PurchasesPage() {
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_MANAGE, '/dashboard/purchases')

  const [restaurant, purchases, suppliers, items] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.purchase.findMany({
      where: { restaurantId: user.restaurantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { supplier: { select: { name: true } }, _count: { select: { items: true } } },
    }),
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true, costPerUnit: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return (
    <PurchasesManager
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      suppliers={suppliers}
      items={items}
      purchases={purchases.map((purchase) => ({
        id: purchase.id,
        number: purchase.number,
        supplierName: purchase.supplier?.name ?? null,
        total: purchase.total,
        status: purchase.status,
        receivedAt: purchase.receivedAt?.toISOString() ?? null,
        itemCount: purchase._count.items,
      }))}
    />
  )
}
