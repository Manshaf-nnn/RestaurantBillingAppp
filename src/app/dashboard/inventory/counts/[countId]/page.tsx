import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { CountSheet } from '@/features/inventory/components/count-sheet'
import { getStockCountDetail } from '@/features/inventory/count-queries'
import { PERMISSIONS, can, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock count' }

export default async function StockCountPage({
  params,
}: {
  params: Promise<{ countId: string }>
}) {
  const { countId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.INVENTORY_COUNT,
    `/dashboard/inventory/counts/${countId}`,
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const detail = await getStockCountDetail({
    restaurantId: user.restaurantId,
    stockCountId: countId,
    currency: restaurant.currency,
  })

  // A count taken at another branch is not this person's to read or approve —
  // approving one posts variance adjustments into that branch's ledger.
  if (detail.branchId && !canAccessBranch(user, detail.branchId)) notFound()

  return (
    <>
      <Link
        href="/dashboard/inventory/counts"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Stock counts
      </Link>

      <PageHeader
        title={detail.reference}
        description={
          [detail.branchName, detail.locationName, detail.countedByName]
            .filter(Boolean)
            .join(' · ') || 'Physical stock count'
        }
      />

      <CountSheet
        detail={detail}
        canApprove={can(user, PERMISSIONS.INVENTORY_COUNT_APPROVE)}
      />
    </>
  )
}
