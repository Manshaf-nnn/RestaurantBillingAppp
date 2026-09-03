import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { NoteButton } from '@/features/accounting/components/note-button'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { formatMoney } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Invoices' }

/**
 * Every invoice, outstanding ones first.
 *
 * Invoices exist from the moment a bill is presented, so "outstanding" means
 * something at last: a numbered document a guest has seen, not yet fully
 * settled. Before this screen the only way to an invoice was through the
 * order that produced it.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.INVOICE_VIEW, '/dashboard/invoices')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const { branchIds } = await selectedBranch(user, await searchParams)

  const invoices = await prisma.invoice.findMany({
    where: {
      restaurantId: user.restaurantId,
      ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}),
    },
    orderBy: { issuedAt: 'desc' },
    take: 200,
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          customerName: true,
          paymentStatus: true,
          grandTotal: true,
          tipAmount: true,
          paidTotal: true,
        },
      },
    },
  })

  // The accountant's notes on these invoices, one query for the whole page.
  const canNote = can(user, PERMISSIONS.ACCOUNTING_NOTE)
  const noteRows = await prisma.accountantNote.findMany({
    where: {
      restaurantId: user.restaurantId,
      entity: 'invoice',
      entityId: { in: invoices.map((invoice) => invoice.id) },
    },
    orderBy: { createdAt: 'desc' },
  })
  const notesByInvoice = new Map<string, typeof noteRows>()
  for (const note of noteRows) {
    const list = notesByInvoice.get(note.entityId) ?? []
    list.push(note)
    notesByInvoice.set(note.entityId, list)
  }

  const outstanding = invoices.filter(
    (invoice) => invoice.order.paymentStatus === 'UNPAID' || invoice.order.paymentStatus === 'PARTIAL',
  )
  const owedTotal = outstanding.reduce(
    (sum, invoice) =>
      sum +
      Math.max(0, invoice.order.grandTotal + invoice.order.tipAmount - invoice.order.paidTotal),
    0,
  )

  return (
    <>
      <PageHeader
        title="Invoices"
        description={
          outstanding.length > 0
            ? `${outstanding.length} outstanding · ${money(owedTotal)} still to collect`
            : 'Every presented bill, numbered and on the record.'
        }
      />
      <SectionCard title="Issued invoices">
        {invoices.length === 0 ? (
          <EmptyState
            title="No invoices yet"
            description="An invoice is issued the moment a bill is presented or settled."
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
                        {invoice.issuedAt.toLocaleDateString()}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {money(invoice.order.grandTotal + invoice.order.tipAmount)}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        {owed > 0 ? (
                          <Badge variant="destructive">{money(owed)} due</Badge>
                        ) : invoice.order.paymentStatus === 'REFUNDED' ? (
                          <Badge variant="outline">refunded</Badge>
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
      </SectionCard>
    </>
  )
}
