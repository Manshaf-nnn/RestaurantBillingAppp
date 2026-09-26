import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { getApprovalPolicy, whyCannotApprove } from '@/features/approvals/service'
import { PoDetail } from '@/features/purchasing/components/po-detail'
import { getPurchaseDetail, pendingPurchaseApproval } from '@/features/purchasing/queries'
import { PO_STATUS } from '@/features/purchasing/status'
import { PERMISSIONS, can, canAccessBranch, visibleBranchIds } from '@/lib/rbac'
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

  // Another branch's order is not this person's to read — the sibling edit
  // page already refused it and this one did not.
  if (detail.branchId && !canAccessBranch(user, detail.branchId)) notFound()

  const canApprove = can(user, PERMISSIONS.PURCHASE_APPROVE)

  /*
   * The desk request behind a pending order, and whether this viewer may
   * decide it normally — asked here, before the button, for the same reason
   * the approvals desk asks: "you cannot approve your own request" belongs
   * beside the control, not in a toast after it is pressed.
   */
  const pending = detail.status === 'PENDING_APPROVAL'
    ? await pendingPurchaseApproval(user.restaurantId, detail.id)
    : null
  const blockedReason = pending && canApprove
    ? whyCannotApprove({
        policy: await getApprovalPolicy(user.restaurantId),
        request: { branchId: pending.branchId, requestedById: pending.requestedById },
        userId: user.id,
        unconfined: visibleBranchIds(user) === null,
      })?.message ?? null
    : null

  const status = PO_STATUS[detail.status]

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
          detail.status === 'PENDING_APPROVAL'
            ? 'Waiting for an approver. Nothing can be received against it until it is approved.'
            : detail.status === 'DRAFT'
              ? 'A draft. Submit it for approval when it is ready.'
              : 'Purchase order'
        }
        actions={<Badge variant={status.variant} size="lg">{status.label}</Badge>}
      />
      <PoDetail
        detail={detail}
        canApprove={canApprove}
        canCreate={can(user, PERMISSIONS.PURCHASE_CREATE)}
        canReceive={can(user, PERMISSIONS.PURCHASE_RECEIVE)}
        approval={{
          pendingId: pending?.id ?? null,
          blockedReason,
          mayForce: can(user, PERMISSIONS.APPROVALS_FORCE),
        }}
      />
    </>
  )
}
