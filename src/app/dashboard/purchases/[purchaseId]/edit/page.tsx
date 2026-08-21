import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { PoBuilder } from '@/features/purchasing/components/po-builder'
import { getPoBuilderData } from '@/features/purchasing/queries'
import { PERMISSIONS, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Edit purchase order' }

/**
 * Correcting a draft order.
 *
 * The service could always do this — `updatePurchaseOrder`, with its rule that
 * only a draft may be edited — and nothing ever called it. There was no action,
 * no route and no button, so a draft with a wrong quantity could only be
 * cancelled and re-raised, losing its number and its history.
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
    include: { items: { select: { itemId: true, quantity: true, unit: true, unitCost: true } } },
  })
  if (!po) notFound()
  if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL') notFound()
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
        description="Still a draft, so it can be changed freely. Once it is approved it becomes a commitment and this page closes."
      />
      <PoBuilder
        data={data}
        editing={{
          purchaseId: po.id,
          number: po.number,
          supplierId: po.supplierId,
          branchId: po.branchId,
          expectedAt: po.expectedAt?.toISOString() ?? null,
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
