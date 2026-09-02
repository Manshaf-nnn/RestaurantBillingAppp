import type { Metadata } from 'next'
import Link from 'next/link'

import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney } from '@/lib/money'
import { formatQuantity } from '@/features/inventory/units'
import { PERMISSIONS } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock ledger' }

/**
 * The whole ledger, across every item.
 *
 * The per-item history answers "what happened to the flour"; this answers
 * "what happened in the storeroom today" — every movement in one stream, each
 * valued at the cost stamped when it happened, filtered to the branch on the
 * switcher. The screen an owner reads top to bottom when a number smells
 * wrong and they do not yet know which item to suspect.
 */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.INVENTORY_VIEW, '/dashboard/inventory/ledger')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  const movements = await prisma.stockMovement.findMany({
    where: {
      restaurantId: user.restaurantId,
      ...(branchId
        ? { branchId }
        : selection.branchIds
          ? { branchId: { in: selection.branchIds } }
          : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      item: { select: { id: true, name: true, unit: true } },
      user: { select: { name: true } },
    },
  })

  const valueIn = movements
    .filter((m) => m.quantity > 0)
    .reduce((sum, m) => sum + Math.round(m.quantity * m.unitCost), 0)
  const valueOut = movements
    .filter((m) => m.quantity < 0)
    .reduce((sum, m) => sum + Math.round(Math.abs(m.quantity) * m.unitCost), 0)

  return (
    <>
      <PageHeader
        title="Stock ledger"
        description="Every movement, newest first, valued at the cost in force when it happened."
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <StatCard label="Value in (listed rows)" value={money(valueIn)} hint="purchases, production, returns" />
        <StatCard label="Value out (listed rows)" value={money(valueOut)} hint="sales at cost, wastage, transfers" />
      </div>
      <SectionCard title="Latest movements" description="The 200 most recent, for the locations on the switcher.">
        {movements.length === 0 ? (
          <EmptyState title="No movements yet" description="Receive stock or take an order and the ledger begins." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">When</th>
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 font-medium">Movement</th>
                  <th className="pb-2 pr-3 text-right font-medium">Change</th>
                  <th className="pb-2 pr-3 text-right font-medium">Value</th>
                  <th className="pb-2 pr-3 text-right font-medium">Balance</th>
                  <th className="pb-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {movements.map((movement) => (
                  <tr key={movement.id}>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      <LocalDateTime value={movement.createdAt.toISOString()} />
                    </td>
                    <td className="max-w-[14rem] truncate py-2.5 pr-3">
                      <Link
                        href={`/dashboard/inventory/${movement.item.id}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {movement.item.name}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 capitalize">
                      {movement.type.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td
                      className={`py-2.5 pr-3 text-right font-medium tabular-nums ${
                        movement.quantity >= 0 ? 'text-success' : 'text-destructive'
                      }`}
                    >
                      {movement.quantity >= 0 ? '+' : '−'}
                      {formatQuantity(Math.abs(movement.quantity), movement.item.unit)}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {movement.unitCost
                        ? money(Math.round(Math.abs(movement.quantity) * movement.unitCost))
                        : '—'}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {movement.balanceAfter === null
                        ? '—'
                        : formatQuantity(movement.balanceAfter, movement.item.unit)}
                    </td>
                    <td className="py-2.5 text-muted-foreground">{movement.user?.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  )
}
