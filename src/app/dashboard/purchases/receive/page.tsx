import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, PackageCheck, Truck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { SearchBox } from '@/components/search-box'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { listAwaitingDelivery, listRecentReceipts } from '@/features/purchasing/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Goods received' }

const STATUS: Record<string, { label: string; variant: 'secondary' | 'warning' | 'success' }> = {
  APPROVED: { label: 'Approved', variant: 'success' },
  ORDERED: { label: 'Ordered', variant: 'secondary' },
  PARTIALLY_RECEIVED: { label: 'Part received', variant: 'warning' },
}

/**
 * What is waiting to be unloaded, and what has been.
 *
 * Receiving has always worked and lived at the bottom of an individual purchase
 * order's page, so the only way to reach it was to already know the order
 * number. A storekeeper standing at a bay with a delivery note had no screen
 * that answered "what are we expecting today". That is why it was reported as
 * "no option to create a GRN from an approved order" — the option existed,
 * somewhere nobody would look.
 *
 * Nothing about receiving itself changes. This is the way in.
 */
export default async function ReceiveGoodsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_VIEW, '/dashboard/purchases/receive')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const search = typeof params.search === 'string' ? params.search : ''
  const branchId = scopeToOne(await selectedBranch(user, params))

  const [awaiting, recent] = await Promise.all([
    listAwaitingDelivery({ restaurantId: user.restaurantId, branchId, search }),
    listRecentReceipts({ restaurantId: user.restaurantId, branchId }),
  ])

  const outstandingValue = awaiting.reduce((sum, po) => sum + po.total, 0)

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
        title="Goods received"
        description="Approved orders still waiting on a delivery. Open one to enter what actually turned up — stock moves then, and not before."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="Awaiting delivery" value={String(awaiting.length)} icon={<Truck />} />
        <StatCard label="Value on order" value={money(outstandingValue)} />
        <StatCard label="Recent deliveries" value={String(recent.length)} icon={<PackageCheck />} />
      </div>

      <div className="mb-4 max-w-sm">
        <SearchBox placeholder="Order number, supplier or item…" defaultValue={search} />
      </div>

      <SectionCard
        title="Awaiting delivery"
        description="Only orders that can actually be received are listed, so nothing here is a dead end."
      >
        {awaiting.length === 0 ? (
          <EmptyState
            title={search ? 'Nothing matches that' : 'Nothing outstanding'}
            description={
              search
                ? 'Try the order number, the supplier, or an item on the order.'
                : 'Every approved order has been received in full. Raise a new order and it will appear here once approved.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {awaiting.map((po) => {
              const status = STATUS[po.status] ?? { label: po.status, variant: 'secondary' as const }
              return (
                <li key={po.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/purchases/${po.id}`}
                        className="font-medium tabular-nums hover:underline"
                      >
                        {po.number}
                      </Link>
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {po.supplierId && po.supplierName ? (
                        <Link
                          href={`/dashboard/suppliers/${po.supplierId}`}
                          className="text-muted-foreground hover:underline"
                        >
                          {po.supplierName}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">No supplier</span>
                      )}
                      {po.branchName ? <Badge variant="secondary">{po.branchName}</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {po.lineCount} item{po.lineCount === 1 ? '' : 's'} ·{' '}
                      {/*
                        The three numbers a storekeeper is holding in their head
                        while they count what came off the van.
                      */}
                      ordered {po.orderedQty}
                      {po.receivedQty > 0 ? ` · received ${po.receivedQty}` : ''} · still to come{' '}
                      <strong>{po.outstandingQty}</strong>
                      {po.expectedAt ? (
                        <>
                          {' · expected '}
                          <LocalDateTime value={po.expectedAt} />
                        </>
                      ) : null}
                    </p>
                  </div>
                  <span className="tabular-nums text-muted-foreground">{money(po.total)}</span>
                  <Button size="sm" asChild>
                    <Link href={`/dashboard/purchases/${po.id}#receive`}>Receive</Link>
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>

      <div className="mt-5">
        <SectionCard
          title="Recent deliveries"
          description="What has already been taken in. Open one to check it against the supplier's invoice."
        >
          {recent.length === 0 ? (
            <EmptyState
              title="No deliveries yet"
              description="Receipts appear here as soon as goods are received against an order."
            />
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                  <Link
                    href={`/dashboard/purchases/${r.purchaseId}/receipts/${r.id}`}
                    className="font-medium tabular-nums hover:underline"
                  >
                    {r.number}
                  </Link>
                  <Link
                    href={`/dashboard/purchases/${r.purchaseId}`}
                    className="tabular-nums text-muted-foreground hover:underline"
                  >
                    {r.purchaseNumber}
                  </Link>
                  <span className="text-muted-foreground">{r.supplierName ?? 'No supplier'}</span>
                  {r.branchName ? <Badge variant="secondary">{r.branchName}</Badge> : null}
                  {r.supplierRef ? (
                    <span className="text-xs text-muted-foreground">Inv {r.supplierRef}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    <LocalDateTime value={r.receivedAt} />
                  </span>
                  <span className="tabular-nums">{money(r.value)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  )
}
