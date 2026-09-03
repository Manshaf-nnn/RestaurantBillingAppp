import type { Metadata } from 'next'
import Link from 'next/link'

import { getApprovalsInbox } from '@/features/accounting/inbox'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { ApprovalCenter } from '@/features/outgoing-payments/components/approval-center'
import { getApprovalTotals, listOutgoingPayments } from '@/features/outgoing-payments/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Payment approvals' }

/**
 * The owner's approval center (accountsds.md §7). The submitter can never be
 * the approver — the server refuses it even for accounts holding this page's
 * permission.
 */
export default async function PaymentApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
    '/dashboard/accounting/approvals',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const selection = await selectedBranch(user, await searchParams)

  const [pending, recent, totals, inbox] = await Promise.all([
    listOutgoingPayments({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      status: ['SUBMITTED'],
    }),
    listOutgoingPayments({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      status: ['APPROVED', 'REJECTED', 'PAID', 'REVERSED'],
      limit: 40,
    }),
    getApprovalTotals({ restaurantId: user.restaurantId, branchIds: selection.branchIds }),
    getApprovalsInbox(user.restaurantId, selection.branchIds),
  ])
  const money = (value: number) => formatMoney(value, restaurant.currency)
  // Payments out have their own console below; the inbox covers the rest.
  const elsewhere = inbox.filter((item) => item.queue !== 'Payment out')

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Money leaves the business only past this desk. Approve, reject with a reason, or send it back for changes."
      />

      {elsewhere.length > 0 ? (
        <div className="mb-5">
          <SectionCard
            title={`Also waiting elsewhere (${elsewhere.length})`}
            description="Other queues, decided on their own screens — each row says exactly what approving does."
          >
            <ul className="divide-y text-sm">
              {elsewhere.map((item) => (
                <li key={`${item.queue}:${item.id}`} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">{item.queue}</span>
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.requestedByName} · {item.requestedAt.toLocaleDateString()} · {item.consequence}
                    </p>
                  </div>
                  <span className="flex items-center gap-3 whitespace-nowrap">
                    {item.amount !== null ? (
                      <span className="font-semibold tabular-nums">{money(item.amount)}</span>
                    ) : null}
                    <Link href={item.href} className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                      Open →
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      ) : null}

      <ApprovalCenter
        pending={pending}
        recent={recent}
        totals={totals}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      />
    </>
  )
}
