import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { ApprovalCenter } from '@/features/outgoing-payments/components/approval-center'
import { getApprovalTotals, listOutgoingPayments } from '@/features/outgoing-payments/queries'
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

  const [pending, recent, totals] = await Promise.all([
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
  ])

  return (
    <>
      <PageHeader
        title="Payment approvals"
        description="Money leaves the business only past this desk. Approve, reject with a reason, or send it back for changes."
      />
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
