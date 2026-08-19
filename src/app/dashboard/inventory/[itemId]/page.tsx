import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { getItemHistory } from '@/features/inventory/history'
import { levelFor } from '@/features/inventory/alerts'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock history' }

/** Inbound movements read green, outbound red, at a glance. */
function toneFor(quantity: number) {
  return quantity >= 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-red-600 dark:text-red-400'
}

export default async function ItemHistoryPage({
  params,
}: {
  params: Promise<{ itemId: string }>
}) {
  const { itemId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.INVENTORY_VIEW,
    `/dashboard/inventory/${itemId}`,
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const { item, rows, ledgerTotal } = await getItemHistory({
    restaurantId: user.restaurantId,
    itemId,
  })

  const money = (minor: number) => formatMoney(minor, restaurant.currency)
  const alert = levelFor(item)
  // The cached balance and the replayed ledger must agree. If they ever do not,
  // saying so plainly beats showing a number nobody can account for.
  const reconciles = Math.abs(item.quantity - ledgerTotal) < 1e-6

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
        title={item.name}
        description={
          [item.sku && `SKU ${item.sku}`, item.branchName, item.locationName]
            .filter(Boolean)
            .join(' · ') || 'Every movement, and what caused it.'
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="In stock"
          value={formatQuantity(item.quantity, item.unit)}
          badge={
            alert ? (
              <Badge variant={alert === 'OVERSTOCK' ? 'secondary' : 'destructive'}>
                {alert.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            ) : null
          }
        />
        <Figure label="Reorder at" value={formatQuantity(item.reorderLevel, item.unit)} />
        <Figure label="Average cost" value={`${money(item.costPerUnit)} / ${UNIT_LABELS[item.unit]}`} />
        <Figure
          label="Last purchase"
          value={item.lastPurchaseCost ? `${money(item.lastPurchaseCost)} / ${UNIT_LABELS[item.unit]}` : '—'}
        />
      </div>

      {!reconciles && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          The stored balance ({formatQuantity(item.quantity, item.unit)}) does not match the sum of
          this ledger ({formatQuantity(ledgerTotal, item.unit)}). The ledger is the source of truth.
        </div>
      )}

      <SectionCard
        title="Stock history"
        description="Newest first. Each row shows the running balance immediately after it."
      >
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nothing has moved yet.
          </p>
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">When</th>
                  <th className="pb-2 pr-3 font-medium">Movement</th>
                  <th className="pb-2 pr-3 text-right font-medium">Change</th>
                  <th className="pb-2 pr-3 text-right font-medium">Balance</th>
                  <th className="pb-2 pr-3 font-medium">Reason</th>
                  <th className="pb-2 pr-3 font-medium">Source</th>
                  <th className="pb-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      <LocalDateTime value={row.createdAt} />
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="capitalize">{row.type.replace(/_/g, ' ').toLowerCase()}</span>
                    </td>
                    <td className={`py-2.5 pr-3 text-right tabular-nums font-medium ${toneFor(row.quantity)}`}>
                      {row.quantity >= 0 ? '+' : '−'}
                      {formatQuantity(
                        row.quantityEntered ?? Math.abs(row.quantity),
                        row.enteredUnit ?? item.unit,
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {row.balanceAfter === null
                        ? '—'
                        : formatQuantity(row.balanceAfter, item.unit)}
                    </td>
                    <td className="max-w-[16rem] truncate py-2.5 pr-3 text-muted-foreground">
                      {row.reason ?? row.notes ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3">
                      {row.sourceHref ? (
                        <Link href={row.sourceHref} className="text-primary underline-offset-2 hover:underline">
                          {row.sourceLabel}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{row.sourceLabel ?? '—'}</span>
                      )}
                    </td>
                    <td className="py-2.5 text-muted-foreground">{row.actorName ?? '—'}</td>
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

function Figure({
  label,
  value,
  badge,
}: {
  label: string
  value: string
  badge?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        {badge}
      </div>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  )
}
