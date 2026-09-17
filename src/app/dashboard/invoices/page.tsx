import type { Metadata } from 'next'
import { formatDate } from '@/lib/datetime'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { NoteButton } from '@/features/accounting/components/note-button'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { InvoiceFilters } from '@/features/payments/components/invoice-filters'
import { INVOICE_LIST_MAX_ROWS, listInvoices, type InvoiceStatusFilter } from '@/features/payments/queries'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange, type RangePreset } from '@/features/reports/range'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { can, PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Invoices' }

const STATUSES: InvoiceStatusFilter[] = ['ALL', 'OUTSTANDING', 'SETTLED', 'REFUNDED', 'FAILED']

/**
 * Rows per page, as the reader asked for it (aO.md §6). Any whole number
 * from one up, clamped to the list's ceiling; anything else — including the
 * old 'ALL' a bookmark may still carry — is fifty.
 */
function readPerPage(raw: string | string[] | undefined): number {
  const parsed = Number(typeof raw === 'string' ? raw : NaN)
  if (!Number.isFinite(parsed) || parsed < 1) return 50
  return Math.min(INVOICE_LIST_MAX_ROWS, Math.trunc(parsed))
}

/**
 * Every invoice issued in a period, outstanding ones first.
 *
 * Invoices exist from the moment a bill is presented, so "outstanding" means
 * something at last: a numbered document a guest has seen, not yet fully
 * settled. The rows and the totals come from one query over one predicate
 * (abc.md §2) — the newest-200-and-add-them-up-in-the-browser version told
 * the accountant a figure that was true of 200 invoices and false of the month.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.INVOICE_VIEW, '/dashboard/invoices')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)

  /*
   * A period, in the one vocabulary every report screen uses — `?preset=`,
   * `?from=`, `?to=` — in the restaurant's own timezone. Invoices open on
   * this month: that is the accountant's unit of work.
   */
  const range = resolveRange({
    preset: (typeof params.preset === 'string' ? params.preset : 'THIS_MONTH') as RangePreset,
    from: typeof params.from === 'string' ? params.from : undefined,
    to: typeof params.to === 'string' ? params.to : undefined,
    timeZone: restaurant.timezone,
  })
  const status = (STATUSES as string[]).includes(String(params.status)) ? (params.status as InvoiceStatusFilter) : 'ALL'
  const perPage = readPerPage(params.perPage)
  const page = typeof params.page === 'string' ? Math.max(1, Number(params.page) || 1) : 1

  const [result, locations] = await Promise.all([
    listInvoices({
      restaurantId: user.restaurantId,
      branchIds: branchId ? [branchId] : selection.branchIds,
      range: { from: range.from, to: range.to },
      status,
      page,
      perPage,
    }),
    listSwitchableLocations(user.restaurantId, visibleBranchIds(user)),
  ])
  const { invoices, totals } = result

  // The accountant's notes on these invoices, one query for the page's rows.
  const canNote = can(user, PERMISSIONS.ACCOUNTING_NOTE)
  const noteRows = invoices.length
    ? await prisma.accountantNote.findMany({
        where: {
          restaurantId: user.restaurantId,
          entity: 'invoice',
          entityId: { in: invoices.map((invoice) => invoice.id) },
        },
        orderBy: { createdAt: 'desc' },
      })
    : []
  const notesByInvoice = new Map<string, typeof noteRows>()
  for (const note of noteRows) {
    const list = notesByInvoice.get(note.entityId) ?? []
    list.push(note)
    notesByInvoice.set(note.entityId, list)
  }

  const pageHref = (target: number) => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && key !== 'page') next.set(key, value)
    }
    next.set('page', String(target))
    return `/dashboard/invoices?${next.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Invoices"
        description={
          totals.outstanding > 0
            ? `${totals.count} invoices · ${range.label} · ${money(totals.outstanding)} still to collect`
            : `${totals.count} invoices · ${range.label} · everything collected`
        }
      />
      <ReportFilters
        preset={range.preset}
        from={range.from.toISOString().slice(0, 10)}
        to={range.to.toISOString().slice(0, 10)}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
        branchId={branchId ?? ''}
      />
      <InvoiceFilters status={status} perPage={perPage} />

      {/* abc.md §2: the whole filtered set's money, whichever page is showing. */}
      <dl
        data-testid="invoice-totals"
        className="mb-4 grid grid-cols-2 gap-2 rounded-xl border bg-card p-3 text-sm shadow-soft sm:grid-cols-4"
      >
        <div>
          <dt className="text-xs text-muted-foreground">Invoices</dt>
          <dd className="font-semibold tabular-nums">{totals.count}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Invoiced</dt>
          <dd className="font-semibold tabular-nums">{money(totals.amount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Collected</dt>
          <dd className="font-semibold tabular-nums text-success">{money(totals.collected)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Outstanding</dt>
          <dd className={totals.outstanding > 0 ? 'font-semibold tabular-nums text-destructive' : 'font-semibold tabular-nums'}>
            {money(totals.outstanding)}
          </dd>
        </div>
      </dl>

      <SectionCard
        title="Issued invoices"
        description={
          result.pageCount > 1
            ? `Page ${result.page} of ${result.pageCount} · ${perPage} a page`
            : undefined
        }
      >
        {invoices.length === 0 ? (
          <EmptyState
            title="No invoices in this period"
            description="An invoice is issued the moment a bill is presented or settled. Widen the period or change the status."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Invoice</th>
                  <th className="pb-2 pr-3 font-medium">Order</th>
                  <th className="pb-2 pr-3 font-medium">Customer</th>
                  <th className="pb-2 pr-3 font-medium">Issued</th>
                  <th className="pb-2 pr-3 text-right font-medium">Amount</th>
                  <th className="pb-2 pr-3 text-right font-medium">Status</th>
                  <th className="pb-2 text-right font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invoices.map((invoice) => {
                  const owed = Math.max(
                    0,
                    invoice.order.grandTotal + invoice.order.tipAmount - invoice.order.paidTotal,
                  )
                  return (
                    <tr key={invoice.id}>
                      <td className="whitespace-nowrap py-2.5 pr-3 font-medium tabular-nums">
                        {invoice.number}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/dashboard/orders/${invoice.order.id}`}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {invoice.order.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3">{invoice.order.customerName}</td>
                      <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                        {formatDate(invoice.issuedAt, { timeZone: restaurant.timezone })}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {money(invoice.order.grandTotal + invoice.order.tipAmount)}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        {owed > 0 ? (
                          <Badge variant="destructive">{money(owed)} due</Badge>
                        ) : invoice.order.paymentStatus === 'REFUNDED' ? (
                          <Badge variant="outline">refunded</Badge>
                        ) : invoice.order.paymentStatus === 'FAILED' ? (
                          <Badge variant="destructive">failed</Badge>
                        ) : (
                          <Badge variant="secondary">settled</Badge>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        <NoteButton
                          entity="invoice"
                          entityId={invoice.id}
                          compact
                          canNote={canNote}
                          notes={(notesByInvoice.get(invoice.id) ?? []).map((note) => ({
                            id: note.id,
                            body: note.body,
                            authorName: note.authorName,
                            createdAt: note.createdAt.toISOString(),
                          }))}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {result.pageCount > 1 ? (
          <div className="mt-3 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Page {result.page} of {result.pageCount} · {result.total} invoices
            </p>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" disabled={result.page <= 1}>
                <Link href={pageHref(Math.max(1, result.page - 1))} aria-disabled={result.page <= 1}>
                  Previous
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" disabled={result.page >= result.pageCount}>
                <Link href={pageHref(Math.min(result.pageCount, result.page + 1))} aria-disabled={result.page >= result.pageCount}>
                  Next
                </Link>
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </>
  )
}
