import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { PoRequestForm } from '@/features/purchasing/components/po-request-form'
import { getPoBuilderData } from '@/features/purchasing/queries'
import { EDITABLE_STATUSES } from '@/features/purchasing/service'
import { PERMISSIONS, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Edit purchase request' }

/**
 * Correcting a request that is still the requester's to change: a draft, one
 * waiting on approval, or one an approver sent back.
 *
 * The status rule is enforced in three places on purpose: here, so the page
 * refuses to open; on the detail page, so the button is not offered; and in the
 * service, which is the one that actually counts. An approved order is a
 * commitment someone signed and a received one is also a stock history.
 */
export default async function EditPurchaseOrderPage({
  params,
}: {
  params: Promise<{ purchaseId: string }>
}) {
  const { purchaseId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASE_CREATE,
    `/dashboard/purchases/${purchaseId}/edit`,
  )
  const restaurant = await requireRestaurant(user.restaurantId)

  const po = await prisma.purchase.findFirst({
    where: { id: purchaseId, restaurantId: user.restaurantId },
    include: {
      createdBy: { select: { name: true } },
      items: { select: { itemId: true, quantity: true, unit: true, unitCost: true } },
    },
  })
  if (!po) notFound()
  if (!EDITABLE_STATUSES.includes(po.status)) notFound()
  if (po.branchId && !canAccessBranch(user, po.branchId)) notFound()

  const data = await getPoBuilderData({
    restaurantId: user.restaurantId,
    currency: restaurant.currency,
  })

  return (
    <>
      <Link
        href={`/dashboard/purchases/${po.id}`}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {po.number}
      </Link>
      <PageHeader
        title={`Edit ${po.number}`}
        description={
          po.status === 'RETURNED'
            ? `Sent back for edit${po.decisionNote ? `: ${po.decisionNote}` : ''}. Correct it and submit again.`
            : 'Still yours to change. Once it is approved it becomes a commitment and this page closes.'
        }
      />
      <PoRequestForm
        data={data}
        requestedBy={po.createdBy?.name ?? user.name}
        canSubmit
        editing={{
          purchaseId: po.id,
          number: po.number,
          status: po.status,
          supplierId: po.supplierId,
          branchId: po.branchId,
          expectedAt: po.expectedAt?.toISOString() ?? null,
          priority: po.priority,
          notes: po.notes,
          discount: po.discount,
          taxTotal: po.taxTotal,
          lines: po.items.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unit: l.unit as string | null,
            unitCost: l.unitCost,
          })),
        }}
      />
    </>
  )
}
