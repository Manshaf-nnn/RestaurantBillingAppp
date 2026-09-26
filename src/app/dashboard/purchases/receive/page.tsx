import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, FileText, PackageCheck, Truck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { GrnForm } from '@/features/purchasing/components/grn-form'
import {
  getPurchaseDetail,
  listAwaitingDelivery,
  listRecentReceipts,
} from '@/features/purchasing/queries'
import { RECEIVABLE_STATUSES } from '@/features/purchasing/service'
import { PO_STATUS } from '@/features/purchasing/status'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, canAccessBranch, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchase receiving / GRN' }

/**
 * Purchase receiving.
 *
 * Select an approved order, its items load, enter what turned up, confirm.
 * Stock moves here and nowhere else in purchasing — and only against an
 * approved order, which is what the select enforces before the server does.
 */
export default async function ReceiveGoodsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  /*
   * `PURCHASE_RECEIVE`, not `PURCHASE_VIEW`.
   *
   * The sidebar has always hidden this screen behind `purchase.receive` while
   * the page asked only for `purchase.view` — so an accountant, who may read
   * purchase orders and must never book goods in against one, could not see
   * the link but could open the URL. Hidden is not denied.
   */
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASE_RECEIVE,
    '/dashboard/purchases/receive',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const branchId = scopeToOne(await selectedBranch(user, params))
  const selectedPo = typeof params.po === 'string' ? params.po : null

  const [awaiting, recent, detail] = await Promise.all([
    listAwaitingDelivery({ restaurantId: user.restaurantId, branchId }),
    listRecentReceipts({ restaurantId: user.restaurantId, branchId }),
    selectedPo
      ? getPurchaseDetail({ restaurantId: user.restaurantId, purchaseId: selectedPo, currency: restaurant.currency })
      : Promise.resolve(null),
  ])

  // An order from another location is not this person's to receive, and one
  // that is not approved is nobody's — the URL is not a way around the select.
  if (detail && detail.branchId && !canAccessBranch(user, detail.branchId)) notFound()
  if (detail && !RECEIVABLE_STATUSES.includes(detail.status)) notFound()

  const allowed = visibleBranchIds(user)
  const locations = (await listSwitchableLocations(user.restaurantId, allowed)).map((l) => ({
    id: l.id,
    name: l.name,
  }))

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
        title="Purchase receiving / GRN"
        description="Receive goods against an approved purchase order. Stock moves then, and not before."
        actions={
          <Badge variant="secondary" size="lg">
            <FileText /> Next GRN is numbered on confirm
          </Badge>
        }
      />

      <GrnForm awaiting={awaiting} detail={detail} receiverName={user.name} locations={locations} />

      {!detail ? (
        <>
          <div className="my-5 grid gap-3 sm:grid-cols-3">
            <StatCard label="Awaiting delivery" value={String(awaiting.length)} icon={<Truck />} />
            <StatCard label="Value on order" value={money(outstandingValue)} />
            <StatCard label="Recent deliveries" value={String(recent.length)} icon={<PackageCheck />} />
          </div>

          <SectionCard
            title="Awaiting delivery"
            description="Only orders that can actually be received are listed, so nothing here is a dead end."
          >
            {awaiting.length === 0 ? (
              <EmptyState
                title="Nothing outstanding"
                description="Every approved order has been received in full. Raise a request and it will appear here once approved."
              />
            ) : (
              <ul className="divide-y divide-border">
                {awaiting.map((po) => {
                  const status = PO_STATUS[po.status]
                  return (
                    <li key={po.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/dashboard/purchases/${po.id}`} className="font-medium tabular-nums hover:underline">
                            {po.number}
                          </Link>
                          <Badge variant={status.variant}>{status.label}</Badge>
                          <span className="text-muted-foreground">{po.supplierName ?? 'No supplier'}</span>
                          {po.branchName ? <Badge variant="secondary">{po.branchName}</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {po.lineCount} item{po.lineCount === 1 ? '' : 's'} · ordered {po.orderedQty}
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
                        <Link href={`/dashboard/purchases/receive?po=${po.id}`}>Receive</Link>
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
                      {r.supplierRef ? <span className="text-xs text-muted-foreground">Inv {r.supplierRef}</span> : null}
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
      ) : null}
    </>
  )
}
