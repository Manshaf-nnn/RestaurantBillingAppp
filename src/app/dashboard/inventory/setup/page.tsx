import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { CatalogManager } from '@/features/catalog/components/catalog-manager'
import { listStockCategories, listUnits } from '@/features/catalog/service'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Units and categories' }

/**
 * The two lists every stock item is built from.
 *
 * Lives under Inventory rather than Settings because it is the answer to a
 * question asked while adding an item — "why isn't my category in this list" —
 * and the answer needs to be one click from where the question is asked.
 */
export default async function InventorySetupPage() {
  const user = await requirePagePermission(
    PERMISSIONS.INVENTORY_VIEW,
    '/dashboard/inventory/setup',
  )

  const [units, categories] = await Promise.all([
    listUnits(user.restaurantId),
    listStockCategories(user.restaurantId),
  ])

  return (
    <>
      <Link
        href="/dashboard/inventory"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Inventory
      </Link>
      <PageHeader
        title="Units and categories"
        description="The two lists every stock item picks from. Getting these right once saves typing them differently forever after."
      />
      <CatalogManager
        units={units}
        categories={categories}
        canManage={can(user, PERMISSIONS.INVENTORY_MANAGE)}
      />
    </>
  )
}
