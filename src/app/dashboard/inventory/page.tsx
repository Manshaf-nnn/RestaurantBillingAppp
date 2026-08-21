import type { Metadata } from 'next'

import { InventoryManager } from '@/features/inventory/components/inventory-manager'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Inventory' }

export default async function InventoryPage() {
  const user = await requirePagePermission(PERMISSIONS.INVENTORY_VIEW, '/dashboard/inventory')

  const [restaurant, items, suppliers] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      orderBy: { name: 'asc' },
      include: { supplier: { select: { name: true } } },
    }),
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return (
    <InventoryManager
      canManage={can(user, PERMISSIONS.INVENTORY_MANAGE)}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      suppliers={suppliers}
      items={items.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit,
        purchaseUnit: item.purchaseUnit,
        unitsPerPurchaseUnit: item.unitsPerPurchaseUnit,
        quantity: item.quantity,
        reorderLevel: item.reorderLevel,
        costPerUnit: item.costPerUnit,
        supplierName: item.supplier?.name ?? null,
        expiryDate: item.expiryDate?.toISOString() ?? null,
      }))}
    />
  )
}
