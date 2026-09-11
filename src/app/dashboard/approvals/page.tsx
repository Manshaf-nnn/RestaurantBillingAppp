import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { CentralApprovals, type ApprovalRow } from '@/features/approvals/components/central-approvals'
import { ApprovalQueue, type ApprovalRow as DecidedRow } from '@/features/approvals/components/approval-queue'
import { getApprovalsInbox } from '@/features/accounting/inbox'
import { listApprovals } from '@/features/approvals/service'
import { PERMISSIONS, can, type Permission } from '@/lib/rbac'
import { localeForCurrency, type CurrencyCode } from '@/lib/money'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Approvals' }

/**
 * One desk for every decision waiting anywhere in the business (bill.md §3).
 *
 * Requests used to be scattered across the screen that raised them: money out
 * on the accounting desk, petty cash in the cash section, transfers in
 * inventory, refunds and discounts here. Each queue knew about itself and
 * nobody could answer "what is waiting on me?" without visiting five pages.
 *
 * This page asks that question once. It decides nothing itself — every row
 * routes to the guarded action that already owns its queue — so permissions,
 * branch guards and audit stay where they are.
 */

/** Which permission lets somebody decide each queue. */
const PERMISSION_FOR_KIND: Record<ApprovalRow['kind'], Permission> = {
  APPROVAL_REQUEST: PERMISSIONS.SETTINGS_MANAGE,
  OUTGOING_PAYMENT: PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
  PETTY_CASH: PERMISSIONS.PETTY_CASH_APPROVE,
  STOCK_COUNT: PERMISSIONS.INVENTORY_COUNT_APPROVE,
  PURCHASE: PERMISSIONS.PURCHASE_APPROVE,
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.APPROVALS_VIEW, '/dashboard/approvals')
  const restaurant = await requireRestaurant(user.restaurantId)

  // Someone confined to a location only sees requests raised there — plus the
  // restaurant-wide ones, which concern everybody.
  const selection = await selectedBranch(user, await searchParams)

  const [waiting, decided] = await Promise.all([
    getApprovalsInbox(user.restaurantId, selection.branchIds),
    listApprovals({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      limit: 40,
    }),
  ])

  const rows: ApprovalRow[] = waiting.map((item) => ({
    queue: item.queue,
    kind: item.kind,
    id: item.id,
    title: item.title,
    reason: item.reason,
    amount: item.amount,
    branchName: item.branchName,
    requestedByName: item.requestedByName,
    // Computed here rather than in the service: whether YOU may decide this
    // depends on who is asking, and services do not read permissions.
    isOwnRequest: item.requestedById === user.id,
    requestedAt: item.requestedAt.toISOString(),
    reference: item.reference,
    consequence: item.consequence,
    decidable: item.decidable,
    canDecide: can(user, PERMISSION_FOR_KIND[item.kind]),
    href: item.href,
  }))

  /*
   * The decided list stays the generic table: it is a history of requests that
   * were ruled on, and the five queues do not share a history the way they
   * share a waiting room.
   */
  const history: DecidedRow[] = decided
    .filter((row) => row.status !== 'PENDING')
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      entity: row.entity,
      amount: row.amount,
      reason: row.reason,
      requestedByName: row.requestedBy?.name ?? null,
      decidedByName: row.decidedBy?.name ?? null,
      branchName: row.branch?.name ?? null,
      requestedAt: row.requestedAt.toISOString(),
      decisionNote: row.decisionNote,
    }))

  const locale =
    restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Everything from every branch that needs a decision. Nothing goes ahead until somebody signs it off."
      />
      <div className="space-y-5">
        <CentralApprovals
          rows={rows}
          currency={restaurant.currency as CurrencyCode}
          timeZone={restaurant.timezone}
          locale={locale}
        />
        <ApprovalQueue rows={history} currency={restaurant.currency} />
      </div>
    </>
  )
}
