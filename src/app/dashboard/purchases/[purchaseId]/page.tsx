import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ReceivePanel } from '@/features/purchasing/components/receive-panel'
import { getPurchaseDetail } from '@/features/purchasing/queries'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
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

  /*
   * Where a delivery may be diverted to. Only what this person may see, so a
   * branch manager cannot receive goods into another site by choosing it from
   * a menu.
   */
  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const locations = (await listSwitchableLocations(user.restaurantId))
    .filter((l) => allowed === null || allowed.includes(l.id))
    .map((l) => ({ id: l.id, name: l.name }))

  // Draft only. The service refuses anything further along, and offering an
  // Edit button that answers with a refusal teaches people the app is broken.
  const editable =
    ['DRAFT', 'PENDING_APPROVAL'].includes(detail.status) &&
    can(user, PERMISSIONS.PURCHASE_CREATE)

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
        description={
          [
            detail.supplierName,
            detail.branchName && `for ${detail.branchName}`,
            detail.createdByName && `raised by ${detail.createdByName}`,
          ]
            .filter(Boolean)
            .join(' · ') || 'Purchase order'
        }
        actions={
          <>
            {detail.branchName ? <Badge variant="secondary">{detail.branchName}</Badge> : null}
            {editable ? (
              <Button variant="outline" asChild>
                <Link href={`/dashboard/purchases/${detail.id}/edit`}>Edit order</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <ReceivePanel
        detail={detail}
        canApprove={can(user, PERMISSIONS.PURCHASE_APPROVE)}
        canReceive={can(user, PERMISSIONS.PURCHASE_RECEIVE)}
        canEdit={editable}
        locations={locations}
      />
    </>
  )
}
