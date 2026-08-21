import type { Metadata } from 'next'

import { InventoryManager } from '@/features/inventory/components/inventory-manager'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { activeUnits, listStockCategories } from '@/features/catalog/service'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Inventory' }

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.INVENTORY_VIEW, '/dashboard/inventory')

  /*
   * An item exists once for the whole restaurant; the *quantity* is per
   * location. With a location chosen this page must show that location's shelf,
   * not the group total — otherwise the warehouse's 100kg of sugar reads as if
   * it were sitting in Kandy, and the first transfer someone tries fails for
   * reasons the screen never explained.
   */
  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  const [restaurant, items, suppliers, branch, units, categories] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      orderBy: { name: 'asc' },
      include: {
        supplier: { select: { name: true } },
        ...(branchId
          ? { locationStock: { where: { branchId }, select: { available: true } } }
          : {}),
      },
    }),
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    selection.branchId
      ? prisma.branch.findFirst({
          where: { id: selection.branchId, restaurantId: user.restaurantId },
          select: { name: true },
        })
      : Promise.resolve(null),
    activeUnits(user.restaurantId),
    listStockCategories(user.restaurantId, { activeOnly: true }),
  ])

  /** This location's shelf, or the group total when no location is chosen. */
  const quantityAt = (item: (typeof items)[number]) =>
    branchId
      ? ('locationStock' in item ? item.locationStock : []).reduce(
          (sum, row) => sum + row.available,
          0,
        )
      : item.quantity

  return (
    <InventoryManager
      canManage={can(user, PERMISSIONS.INVENTORY_MANAGE)}
      branchName={branch?.name ?? null}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      suppliers={suppliers}
      units={units.map((u) => ({ code: u.code, name: u.name, symbol: u.symbol }))}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      items={items.map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        category: item.category,
        unit: item.unit,
        purchaseUnit: item.purchaseUnit,
        unitsPerPurchaseUnit: item.unitsPerPurchaseUnit,
        quantity: quantityAt(item),
        reorderLevel: item.reorderLevel,
        minStock: item.minStock,
        maxStock: item.maxStock,
        costPerUnit: item.costPerUnit,
        supplierId: item.supplierId,
        supplierName: item.supplier?.name ?? null,
        storageArea: item.storageArea,
        expiryDate: item.expiryDate?.toISOString() ?? null,
      }))}
    />
  )
}
