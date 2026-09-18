import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { AdjustmentsBoard, type AdjustmentRequestRow, type PostedAdjustmentRow } from '@/features/inventory/components/adjustments-board'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock adjustments' }

/**
 * Corrections to a counted balance (stockMa.md).
 *
 * Two people use this screen and they see different buttons, decided by what
 * they may do rather than by which link they followed: somebody holding
 * `inventory.adjust` posts the correction here and now, and a stock keeper
 * sends it to the approvals desk and watches it here until it is ruled on.
 *
 * Until this existed there was no adjustment screen at all — the action had
 * been written and never given a door — so the only way to correct a balance
 * was `recordStockMovement`, which needs `inventory.manage` and brings item
 * editing with it.
 */
export default async function AdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.INVENTORY_ADJUST_REQUEST,
    '/dashboard/inventory/adjustments',
  )
  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * The item CATALOGUE stays restaurant-wide — it is the picker for "which
   * item is wrong" — while the records and the balances are this location's.
   * Same split the wastage screen makes.
   */
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)
  const canApplyDirectly = can(user, PERMISSIONS.INVENTORY_ADJUST)

  const [items, requests, posted] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true, quantity: true },
      orderBy: { name: 'asc' },
    }),
    prisma.approvalRequest.findMany({
      where: {
        restaurantId: user.restaurantId,
        kind: 'STOCK_ADJUSTMENT',
        ...(selection.branchIds ? { branchId: { in: selection.branchIds } } : {}),
      },
      orderBy: { requestedAt: 'desc' },
      take: 40,
      include: { branch: { select: { name: true } } },
    }),
    prisma.stockMovement.findMany({
      where: {
        restaurantId: user.restaurantId,
        type: { in: ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] },
        ...(selection.branchIds ? { branchId: { in: selection.branchIds } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: {
        item: { select: { name: true, unit: true } },
        user: { select: { name: true } },
        branch: { select: { name: true } },
      },
    }),
  ])

  const requestRows: AdjustmentRequestRow[] = requests.map((row) => {
    const payload = (row.payload ?? {}) as {
      reference?: string
      itemName?: string
      quantity?: number
      unit?: string
      direction?: 'IN' | 'OUT'
    }
    return {
      id: row.id,
      reference: payload.reference ?? row.entityId ?? '—',
      itemName: payload.itemName ?? 'An item',
      quantity: payload.quantity ?? 0,
      unit: payload.unit ?? '',
      direction: payload.direction === 'OUT' ? 'OUT' : 'IN',
      reason: row.reason,
      status: row.status,
      value: formatMoney(row.amount ?? 0, restaurant.currency),
      branchName: row.branch?.name ?? null,
      requestedAt: row.requestedAt.toISOString(),
      decisionNote: row.decisionNote,
      mine: row.requestedById === user.id,
    }
  })

  const postedRows: PostedAdjustmentRow[] = posted.map((row) => ({
    id: row.id,
    itemName: row.item.name,
    quantity: row.quantityEntered ?? Math.abs(row.quantity),
    unit: (row.enteredUnit ?? row.item.unit) as string,
    direction: row.type === 'ADJUSTMENT_IN' ? 'IN' : 'OUT',
    reason: row.reason,
    reference: row.referenceId,
    byName: row.user?.name ?? null,
    branchName: row.branch?.name ?? null,
    at: row.createdAt.toISOString(),
  }))

  return (
    <>
      <PageHeader
        title="Stock adjustments"
        description={
          canApplyDirectly
            ? 'Correct a counted balance. What you post here moves stock immediately and is recorded against your name.'
            : 'Found a shelf that disagrees with the system? Say so here. Nothing moves until somebody signs it off.'
        }
      />
      <AdjustmentsBoard
        items={items}
        requests={requestRows}
        posted={postedRows}
        canApplyDirectly={canApplyDirectly}
        branchId={branchId === '__none__' ? null : branchId}
      />
    </>
  )
}
