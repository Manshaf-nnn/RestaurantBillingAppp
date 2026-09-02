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
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
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
  /*
   * The ITEM is restaurant-wide — one definition, one SKU — so this page is
   * open to anyone who may see stock. What it HOLDS is per branch, and this
   * page was showing every location's holdings and movements to somebody
   * confined to one of them.
   */
  const { item, rows, ledgerTotal, stockByLocation, purchases } = await getItemHistory({
    restaurantId: user.restaurantId,
    itemId,
    branchIds: visibleBranchIds({ role: user.role, branchId: user.branchId }),
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

      {/*
        What the item IS, before what has happened to it. This page was named
        after an item and could not tell you its category, its supplier, how it
        is bought or when it was added — you had to go back to the list and open
        the edit dialog to find out.
      */}
      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <SectionCard title="Details" className="lg:col-span-2">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail label="Item code / SKU">{item.sku ?? '—'}</Detail>
            <Detail label="Category">{item.category ?? '—'}</Detail>
            <Detail label="Counted in">{UNIT_LABELS[item.unit]}</Detail>
            <Detail label="Bought as">
              {item.purchaseUnit
                ? `${item.purchaseUnit.toLowerCase()}${
                    item.unitsPerPurchaseUnit
                      ? ` of ${item.unitsPerPurchaseUnit} ${UNIT_LABELS[item.unit]}`
                      : ''
                  }`
                : 'Same as counted'}
            </Detail>
            <Detail label="Supplier">
              {item.supplierId && item.supplierName ? (
                <Link
                  href={`/dashboard/suppliers/${item.supplierId}`}
                  className="text-primary hover:underline"
                >
                  {item.supplierName}
                </Link>
              ) : (
                '—'
              )}
            </Detail>
            <Detail label="Storage area">{item.storageArea ?? '—'}</Detail>
            <Detail label="Minimum stock">{formatQuantity(item.minStock, item.unit)}</Detail>
            <Detail label="Maximum (par)">
              {item.maxStock ? formatQuantity(item.maxStock, item.unit) : '—'}
            </Detail>
            <Detail label="Status">
              {item.isActive ? 'Active' : <Badge variant="secondary">Removed</Badge>}
            </Detail>
            <Detail label="Expiry">
              {item.expiryDate ? <LocalDateTime value={item.expiryDate} /> : '—'}
            </Detail>
            <Detail label="Created">
              <LocalDateTime value={item.createdAt} />
            </Detail>
            <Detail label="Last updated">
              <LocalDateTime value={item.updatedAt} />
            </Detail>
          </dl>
        </SectionCard>

        <SectionCard
          title="Where it is"
          description="One item, many shelves. The total above is all of them added up."
        >
          {stockByLocation.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not held anywhere yet. Stock appears here once it is received, transferred in or an
              opening balance is set.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {stockByLocation.map((row) => (
                <li key={row.branchId} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/dashboard/locations/${row.branchId}`}
                      className="font-medium hover:underline"
                    >
                      {row.branchName}
                    </Link>
                    <span className="tabular-nums">
                      {formatQuantity(row.available, item.unit)}
                    </span>
                  </div>
                  {row.reserved > 0 || row.inTransit > 0 ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.reserved > 0 ? `${row.reserved} reserved` : ''}
                      {row.reserved > 0 && row.inTransit > 0 ? ' · ' : ''}
                      {row.inTransit > 0 ? `${row.inTransit} in transit` : ''}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="mb-5">
        <SectionCard
          title="Purchase history"
          description="What was actually received, not what was ordered. An order is a promise; a receipt is a fact."
        >
          {purchases.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Never bought through a purchase order. Deliveries recorded against one appear here
              with what they cost.
            </p>
          ) : (
            <div className="-mx-2 overflow-x-auto px-2">
              <table className="w-full min-w-[38rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Received</th>
                    <th className="pb-2 pr-3 font-medium">GRN</th>
                    <th className="pb-2 pr-3 font-medium">Order</th>
                    <th className="pb-2 pr-3 font-medium">Supplier</th>
                    <th className="pb-2 pr-3 text-right font-medium">Quantity</th>
                    <th className="pb-2 pr-3 text-right font-medium">Unit cost</th>
                    <th className="pb-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {purchases.map((row, index) => (
                    <tr key={`${row.receiptId}-${index}`}>
                      <td className="py-2 pr-3 text-muted-foreground">
                        <LocalDateTime value={row.receivedAt} />
                      </td>
                      <td className="py-2 pr-3">
                        <Link
                          href={`/dashboard/purchases/${row.purchaseId}/receipts/${row.receiptId}`}
                          className="tabular-nums hover:underline"
                        >
                          {row.receiptNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">
                        <Link
                          href={`/dashboard/purchases/${row.purchaseId}`}
                          className="tabular-nums hover:underline"
                        >
                          {row.purchaseNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{row.supplierName ?? '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.quantity} {row.unit?.toLowerCase() ?? UNIT_LABELS[item.unit]}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(row.unitCost)}</td>
                      <td className="py-2 text-right tabular-nums">{money(row.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

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
                  <th className="pb-2 pr-3 text-right font-medium">Value</th>
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
                    {/* What the movement was WORTH, at the cost stamped when
                        it happened — the ledger answers in money as well as
                        in quantity (§75). */}
                    <td className={`py-2.5 pr-3 text-right tabular-nums ${toneFor(row.quantity)}`}>
                      {row.unitCost
                        ? money(Math.round(Math.abs(row.quantity) * row.unitCost))
                        : '—'}
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

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  )
}
