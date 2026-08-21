import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getReceiptDetail } from '@/features/purchasing/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Goods receipt' }

/**
 * One delivery, in full.
 *
 * GRNs existed only as a cramped nested list inside the purchase order page —
 * item names and quantities, no costs, no total, no destination, nothing to
 * print, nothing to link to. A goods receipt is the document a supplier's
 * invoice gets checked against, so it has to stand on its own and it has to
 * lead somewhere: back to the order, out to the supplier, down to each item.
 *
 * Deliberately read-only. A receipt has already moved stock and already written
 * to the ledger; editing it after the fact would leave the balance and its own
 * history disagreeing, which is the one thing this whole system is built not to
 * allow. A wrong delivery is corrected by a further movement — a return to the
 * supplier or an adjustment with a reason — so the record shows what happened
 * rather than what someone wishes had happened.
 */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ purchaseId: string; receiptId: string }>
}) {
  const { purchaseId, receiptId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASE_VIEW,
    `/dashboard/purchases/${purchaseId}/receipts/${receiptId}`,
  )
  const restaurant = await requireRestaurant(user.restaurantId)

  const receipt = await getReceiptDetail({
    restaurantId: user.restaurantId,
    receiptId,
    currency: restaurant.currency,
  })
  if (!receipt || receipt.purchaseId !== purchaseId) notFound()

  // A delivery into a location this person has nothing to do with is not theirs
  // to read, whatever id is in the address bar.
  if (receipt.branchId && !canAccessBranch(user, receipt.branchId)) notFound()

  const money = (m: number) => formatMoney(m, restaurant.currency)
  const shortfall = receipt.lines.filter((l) => l.acceptedQty + l.rejectedQty < l.orderedQty)
  const repriced = receipt.lines.filter((l) => l.unitCost !== l.orderedUnitCost)

  return (
    <>
      <Link
        href={`/dashboard/purchases/${purchaseId}`}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {receipt.purchaseNumber}
      </Link>

      <PageHeader
        title={receipt.number}
        description={[
          receipt.supplierName,
          receipt.branchName && `received at ${receipt.branchName}`,
          receipt.supplierRef && `invoice ${receipt.supplierRef}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Value received" value={money(receipt.acceptedTotal)} tone="primary" />
        <StatCard label="Lines" value={String(receipt.lines.length)} />
        <StatCard
          label="Rejected lines"
          value={String(receipt.rejectedCount)}
          tone={receipt.rejectedCount > 0 ? 'warning' : 'default'}
        />
        <StatCard label="Order status" value={receipt.purchaseStatus.replace(/_/g, ' ').toLowerCase()} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <SectionCard
            title="What arrived"
            description="Ordered against accepted. Only the accepted quantity ever entered stock."
          >
            <div className="-mx-2 overflow-x-auto px-2">
              <table className="w-full min-w-[42rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Item</th>
                    <th className="pb-2 pr-3 text-right font-medium">Ordered</th>
                    <th className="pb-2 pr-3 text-right font-medium">Accepted</th>
                    <th className="pb-2 pr-3 text-right font-medium">Rejected</th>
                    <th className="pb-2 pr-3 text-right font-medium">Unit cost</th>
                    <th className="pb-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {receipt.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/dashboard/inventory/${line.itemId}`}
                          className="font-medium hover:underline"
                        >
                          {line.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {[
                            line.sku,
                            line.batchNo && `batch ${line.batchNo}`,
                            line.rejectReason,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                        {line.orderedQty} {line.unit.toLowerCase()}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {line.acceptedQty}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-amber-600 dark:text-amber-400">
                        {line.rejectedQty || '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {money(line.unitCost)}
                        {line.unitCost !== line.orderedUnitCost ? (
                          <span className="block text-xs text-muted-foreground line-through">
                            {money(line.orderedUnitCost)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{money(line.lineTotal)}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="pt-2.5" colSpan={5}>
                      Received on this delivery
                    </td>
                    <td className="pt-2.5 text-right tabular-nums">{money(receipt.acceptedTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {repriced.length > 0 ? (
              <p className="mt-3 border-l-2 border-amber-500/50 pl-3 text-sm text-muted-foreground">
                {repriced.length} line{repriced.length === 1 ? '' : 's'} cost something other than
                the order said. The delivered price is what the ledger recorded, because that is
                what was actually paid — the ordered price is shown struck through beside it.
              </p>
            ) : null}

            {shortfall.length > 0 ? (
              <p className="mt-3 border-l-2 border-border pl-3 text-sm text-muted-foreground">
                {shortfall.length} line{shortfall.length === 1 ? ' is' : 's are'} short of what was
                ordered. The remainder stays open on{' '}
                <Link href={`/dashboard/purchases/${purchaseId}`} className="text-primary hover:underline">
                  {receipt.purchaseNumber}
                </Link>{' '}
                and can be received later.
              </p>
            ) : null}
          </SectionCard>

          {receipt.notes ? (
            <SectionCard title="Notes">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{receipt.notes}</p>
            </SectionCard>
          ) : null}
        </div>

        <SectionCard title="This delivery">
          <dl className="space-y-2.5 text-sm">
            <Row label="Order">
              <Link
                href={`/dashboard/purchases/${purchaseId}`}
                className="tabular-nums text-primary hover:underline"
              >
                {receipt.purchaseNumber}
              </Link>
            </Row>
            <Row label="Supplier">
              {receipt.supplierId && receipt.supplierName ? (
                <Link
                  href={`/dashboard/suppliers/${receipt.supplierId}`}
                  className="text-primary hover:underline"
                >
                  {receipt.supplierName}
                </Link>
              ) : (
                '—'
              )}
            </Row>
            <Row label="Received at">
              {receipt.branchName ?? '—'}
              {receipt.locationName ? (
                <span className="text-muted-foreground"> · {receipt.locationName}</span>
              ) : null}
            </Row>
            <Row label="Their invoice">{receipt.supplierRef ?? '—'}</Row>
            <Row label="Received">
              <LocalDateTime value={receipt.receivedAt} />
            </Row>
            <Row label="Received by">{receipt.receivedByName ?? '—'}</Row>
          </dl>

          <p className="mt-4 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
            A receipt cannot be edited. It has already moved stock and written to the ledger, and
            changing it now would leave the balance and its own history disagreeing. Correct a
            wrong delivery with a return to the supplier or a stock adjustment, so the record shows
            what happened.
          </p>
        </SectionCard>
      </div>

      {receipt.rejectedCount > 0 ? (
        <div className="mt-5">
          <SectionCard
            title="Rejected on arrival"
            description="Recorded, never counted into stock. This is what you invoice-check against."
          >
            <ul className="divide-y divide-border">
              {receipt.lines
                .filter((l) => l.rejectedQty > 0)
                .map((line) => (
                  <li key={line.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <span className="font-medium">{line.name}</span>
                    <Badge variant="warning">
                      {line.rejectedQty} {line.unit.toLowerCase()} rejected
                    </Badge>
                    <span className="text-muted-foreground">
                      {line.rejectReason ?? 'No reason given'}
                    </span>
                  </li>
                ))}
            </ul>
          </SectionCard>
        </div>
      ) : null}
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
