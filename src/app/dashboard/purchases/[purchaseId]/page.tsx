import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ReceivePanel } from '@/features/purchasing/components/receive-panel'
import { getPurchaseDetail } from '@/features/purchasing/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchase order' }

export default async function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ purchaseId: string }>
}) {
  const { purchaseId } = await params
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_VIEW, `/dashboard/purchases/${purchaseId}`)
  const restaurant = await requireRestaurant(user.restaurantId)
  const detail = await getPurchaseDetail({
    restaurantId: user.restaurantId,
    purchaseId,
    currency: restaurant.currency,
  })

  return (
    <>
      <Link
        href="/dashboard/purchases"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Purchasing
      </Link>
      <PageHeader
        title={detail.number}
        description={[detail.supplierName, detail.createdByName && `raised by ${detail.createdByName}`]
          .filter(Boolean)
          .join(' · ') || 'Purchase order'}
      />
      <ReceivePanel
        detail={detail}
        canApprove={user.permissions.includes(PERMISSIONS.PURCHASE_APPROVE)}
        canReceive={user.permissions.includes(PERMISSIONS.PURCHASE_RECEIVE)}
      />
    </>
  )
}
