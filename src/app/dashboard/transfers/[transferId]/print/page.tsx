import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PrintButton } from '@/features/transfers/components/transfer-report-toolbar'
import { getTransferDetail } from '@/features/transfers/queries'
import { assertTransferSide } from '@/features/transfers/service'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { formatDateTime } from '@/lib/datetime'
import { formatMoney } from '@/lib/money'
import { roundQty } from '@/lib/quantity'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Transfer note' }

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  DISPATCHED: 'In transit',
  IN_TRANSIT: 'In transit',
  RECEIVED: 'Received',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
}

/**
 * One transfer, as a document.
 *
 * A stock movement between two locations is a thing people sign for, file, and
 * argue about three weeks later when a case is missing — so it needs to exist
 * on paper, with both parties named, every quantity at all three stages, and
 * the variance and its reason where somebody can see them without opening the
 * app.
 *
 * `window.print()` and the `@media print` rules in `globals.css` do the whole
 * job: the sidebar and the header are stripped, the table head repeats across
 * pages, and Save-as-PDF renders exactly this. A PDF library would be a second
 * layout to keep in step with this one, and it would lose that race.
 */
export default async function TransferPrintPage({
  params,
}: {
  params: Promise<{ transferId: string }>
}) {
  const { transferId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.TRANSFER_VIEW,
    `/dashboard/transfers/${transferId}/print`,
  )
  const [detail, restaurant] = await Promise.all([
    getTransferDetail({ restaurantId: user.restaurantId, transferId }),
    requireRestaurant(user.restaurantId),
  ])

  /*
   * The same gate the detail page applies. A transfer between two other
   * locations is none of a branch manager's business, and "it is only the
   * printable version" is not a reason to answer a question the screen refuses.
   */
  assertTransferSide(user, detail, 'EITHER')

  const when = (value: string | null) =>
    value ? formatDateTime(value, { locale: restaurant.locale, timeZone: restaurant.timezone }) : '—'
  const money = (cents: number) => formatMoney(cents, restaurant.currency)

  const totalValue = detail.lines.reduce((sum, line) => sum + line.lineValue, 0)
  const hasVariance = detail.lines.some((l) => l.variance !== null && Math.abs(l.variance) > 1e-6)

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/dashboard/transfers/${detail.id}`}>
            <ArrowLeft /> Back to transfer
          </Link>
        </Button>
        <PrintButton label="Print / save as PDF" />
      </div>

      <div className="print-sheet mx-auto max-w-4xl rounded-xl border bg-card p-6 shadow-soft">
        {/* ── Heading ───────────────────────────────────────────────────── */}
        <header className="border-b pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-lg font-bold">{restaurant.name}</p>
              <p className="text-sm text-muted-foreground">Stock transfer note</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold tabular-nums">{detail.number}</p>
              <p className="text-sm">{STATUS_LABEL[detail.status] ?? detail.status}</p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">From</p>
              <p className="font-medium">{detail.fromName}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">To</p>
              <p className="font-medium">{detail.toName}</p>
            </div>
          </div>
        </header>

        {/* ── Who touched it, and when ──────────────────────────────────── */}
        <dl className="grid gap-x-6 gap-y-3 border-b py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Party label="Requested by" who={detail.requestedByName} at={when(detail.requestedAt)} />
          <Party label="Approved by" who={detail.approvedByName} at={when(detail.approvedAt)} />
          <Party label="Dispatched by" who={detail.dispatchedByName} at={when(detail.dispatchedAt)} />
          <Party label="Received by" who={detail.receivedByName} at={when(detail.receivedAt)} />
        </dl>

        {/*
          Why it was refused, on the paper.
          It was stored from the first version of this feature and never read
          back anywhere, so a rejected transfer said it was rejected and not
          why — the one thing anybody holding a rejected transfer wants.
        */}
        {detail.rejectReason ? (
          <p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <span className="font-medium">Rejected:</span> {detail.rejectReason}
          </p>
        ) : null}

        {/* ── The lines ─────────────────────────────────────────────────── */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Item</th>
                <th className="py-2 pr-3 font-medium">Unit</th>
                <th className="py-2 pr-3 text-right font-medium">Requested</th>
                <th className="py-2 pr-3 text-right font-medium">Sent</th>
                <th className="py-2 pr-3 text-right font-medium">Received</th>
                <th className="py-2 pr-3 text-right font-medium">Variance</th>
                <th className="py-2 pr-3 font-medium">Reason</th>
                <th className="py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {detail.lines.map((line, index) => {
                const short = line.variance !== null && line.variance < -1e-6
                return (
                  <tr key={line.id}>
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">{index + 1}</td>
                    <td className="py-2 pr-3">{line.name}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{line.unit}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{roundQty(line.requestedQty)}</td>
                    {/* An em dash, not a zero: not yet sent is not "nil sent". */}
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {line.sentQty === null ? '—' : roundQty(line.sentQty)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {line.receivedQty === null ? '—' : roundQty(line.receivedQty)}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right tabular-nums ${short ? 'font-medium text-destructive' : ''}`}
                    >
                      {line.variance === null ? '—' : roundQty(line.variance)}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {line.varianceReason
                        ? `${line.varianceReason.replaceAll('_', ' ').toLowerCase()}${line.varianceNote ? ` — ${line.varianceNote}` : ''}`
                        : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">{money(line.lineValue)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2 pr-3" colSpan={8}>
                  Total value
                </td>
                <td className="py-2 text-right tabular-nums">{money(totalValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {hasVariance ? (
          <p className="mt-3 text-xs text-destructive">
            This transfer arrived short or damaged. The variance column is the difference between
            what was sent and what was accepted.
          </p>
        ) : null}

        {detail.notes ? (
          <div className="mt-4 border-t pt-3 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Notes</p>
            <p className="mt-1">{detail.notes}</p>
          </div>
        ) : null}

        {/* ── Signatures ────────────────────────────────────────────────── */}
        <div className="mt-8 grid gap-8 sm:grid-cols-2">
          <Signature label="Dispatched by" name={detail.dispatchedByName} />
          <Signature label="Received by" name={detail.receivedByName} />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Printed {formatDateTime(new Date(), { locale: restaurant.locale, timeZone: restaurant.timezone })}
          {' · '}
          {restaurant.name}
        </p>
      </div>
    </>
  )
}

function Party({ label, who, at }: { label: string; who: string | null; at: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{who ?? '—'}</dd>
      <dd className="text-xs text-muted-foreground">{at}</dd>
    </div>
  )
}

/**
 * A line to sign on, with the recorded name printed under it.
 *
 * The name is what the system believes; the signature is what the person
 * standing there confirms. Both, because a transfer note with only one of them
 * settles no argument.
 */
function Signature({ label, name }: { label: string; name: string | null }) {
  return (
    <div>
      <div className="h-12 border-b border-dashed" />
      <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{name ?? '—'}</p>
    </div>
  )
}
