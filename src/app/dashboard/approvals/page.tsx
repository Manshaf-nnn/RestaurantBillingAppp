import type { Metadata } from 'next'
import type { ApprovalKind } from '@prisma/client'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { CentralApprovals, type ApprovalRow } from '@/features/approvals/components/central-approvals'
import { ApprovalQueue, type ApprovalRow as DecidedRow } from '@/features/approvals/components/approval-queue'
import { getApprovalsInbox, type InboxKind } from '@/features/accounting/inbox'
import {
  RESTAURANT_WIDE,
  getApprovalPolicy,
  listApprovals,
} from '@/features/approvals/service'
import { DECIDE_PERMISSION } from '@/features/approvals/permissions'
import { ApprovalFilters } from '@/features/approvals/components/approval-filters'
import { ApprovalAccess } from '@/features/approvals/components/approval-access'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { ROLE_LABELS, canAccessBranch, permissionsFor, visibleBranchIds } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { PERMISSIONS, can, type Permission } from '@/lib/rbac'
import { localeForCurrency, type CurrencyCode } from '@/lib/money'
import { branchNameFor, selectedBranch } from '@/features/dashboard/selected-branch'
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

/**
 * Which permission lets somebody decide each of the OTHER queues. The generic
 * queue is per kind — `DECIDE_PERMISSION` — because a transfer and a refund
 * are different acts with different owners (recorrection.md §1).
 */
const PERMISSION_FOR_KIND: Record<Exclude<InboxKind, 'APPROVAL_REQUEST'>, Permission> = {
  OUTGOING_PAYMENT: PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
  PETTY_CASH: PERMISSIONS.PETTY_CASH_APPROVE,
  STOCK_COUNT: PERMISSIONS.INVENTORY_COUNT_APPROVE,
  PURCHASE: PERMISSIONS.PURCHASE_APPROVE,
  WASTAGE: PERMISSIONS.INVENTORY_WASTAGE_APPROVE,
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
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')

  const manages = can(user, PERMISSIONS.APPROVALS_MANAGE)

  /*
   * One set of filters, both lists (recorrection.md §1). The first cut passed
   * them to the history table only, so choosing "Waiting" emptied the history
   * and changed the pending desk not at all. Every one is validated or ignored
   * by the service; an unknown status or kind simply does not narrow anything.
   */
  const filters = {
    status: str('status') || undefined,
    kind: str('kind') || undefined,
    requestedById: str('requestedBy') || undefined,
    fromBranchId: str('fromBranch') || undefined,
    toBranchId: str('toBranch') || undefined,
  }
  const filtered = Object.values(filters).some(Boolean)

  const [waiting, decided, branchName, locations, policy, staff] = await Promise.all([
    getApprovalsInbox(user.restaurantId, selection.branchIds, filters),
    listApprovals({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      limit: 40,
      status: filters.status as never,
      // The wastage queue is not an ApprovalKind; the history has none of it.
      kind: (filters.kind === 'STOCK_WRITEOFF' ? '__none__' : filters.kind) as never,
      requestedById: filters.requestedById,
      fromBranchId: filters.fromBranchId,
      toBranchId: filters.toBranchId,
    }),
    branchNameFor(user.restaurantId, selection.branchId),
    listSwitchableLocations(user.restaurantId, visibleBranchIds(user)),
    manages ? getApprovalPolicy(user.restaurantId) : Promise.resolve(null),
    /*
     * Everyone who could be named as an approver, or who could have raised a
     * request. Same list for both filters, because "who asked" and "who may
     * answer" are drawn from the same staff.
     */
    prisma.user.findMany({
      where: { restaurantId: user.restaurantId, isActive: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        role: true,
        permissions: true,
        branch: { select: { name: true } },
        staffRole: { select: { permissions: true, isActive: true } },
      },
      orderBy: { name: 'asc' },
    }),
  ])

  const rows: ApprovalRow[] = waiting.map((item) => {
    /*
     * Computed here rather than in the service: whether YOU may decide this
     * depends on who is asking, and services do not read permissions.
     *
     * Three things have to be true: the permission for this queue (for the
     * generic queue, for this KIND), and being at the branch that owns the
     * decision — a transfer's is the source. The destination sees its own
     * request as a watcher, and the row says what it is waiting for.
     */
    const permission =
      item.kind === 'APPROVAL_REQUEST'
        ? (DECIDE_PERMISSION[item.approvalKind as ApprovalKind] ?? null)
        : PERMISSION_FOR_KIND[item.kind]
    const atBranch = item.branchId === null || canAccessBranch(user, item.branchId)
    const canDecide = permission !== null && can(user, permission) && atBranch

    return {
      category: item.category,
      queue: item.queue,
      kind: item.kind,
      id: item.id,
      title: item.title,
      reason: item.reason,
      amount: item.amount,
      branchName: item.branchName,
      requestedByName: item.requestedByName,
      isOwnRequest: item.requestedById === user.id,
      requestedAt: item.requestedAt.toISOString(),
      reference: item.reference,
      consequence: item.consequence,
      decidable: item.decidable,
      canDecide,
      waitingOn:
        item.transfer && !atBranch
          ? `Waiting for ${item.transfer.fromBranchName} to approve`
          : null,
      href: item.href,
      transfer: item.transfer
        ? {
            number: item.transfer.number,
            fromBranchName: item.transfer.fromBranchName,
            toBranchName: item.transfer.toBranchName,
            lines: item.transfer.lines,
          }
        : null,
    }
  })

  /*
   * The decided list stays the generic table: it is a history of requests that
   * were ruled on, and the six queues do not share a history the way they
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
      forcedAt: row.forcedAt?.toISOString() ?? null,
    }))

  const locale =
    restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  /*
   * Only people who can open the queue can be named as approvers. The action
   * checks this again on write — this list is a convenience, never the gate —
   * but offering somebody who cannot open the screen would build a location
   * whose approver list is full and whose queue nobody can clear.
   */
  const canApproveHere = staff.filter((member) =>
    permissionsFor({
      role: member.role,
      permissions: member.permissions,
      rolePermissions:
        member.staffRole && member.staffRole.isActive ? member.staffRole.permissions : null,
    }).has(PERMISSIONS.APPROVALS_VIEW),
  )
  const nameOf = new Map(staff.map((m) => [m.id, m.name]))

  // Name, role, location — the one convention for every people picker
  // (recorrection.md §4).
  const person = (m: (typeof staff)[number]) => ({
    id: m.id,
    name: m.name,
    roleLabel: ROLE_LABELS[m.role] ?? m.role,
    branchName: m.branch?.name ?? null,
  })

  /*
   * A branch manager sets their own branch's list and sees only that
   * (recorrection.md §1). The restaurant-wide row is for somebody who works
   * across every location; the action refuses everyone else, so offering it
   * would be offering a form that cannot be saved.
   */
  const unconfined = visibleBranchIds(user) === null
  const accessRows = policy
    ? [
        ...(unconfined
          ? [
              {
                branchId: '',
                branchName: 'All locations',
                approvers: (policy.approvers?.[RESTAURANT_WIDE] ?? [])
                  .filter((id) => nameOf.has(id))
                  .map((id) => ({ id, name: nameOf.get(id)! })),
              },
            ]
          : []),
        ...locations.map((l) => ({
          branchId: l.id,
          branchName: l.name,
          approvers: (policy.approvers?.[l.id] ?? [])
            .filter((id) => nameOf.has(id))
            .map((id) => ({ id, name: nameOf.get(id)! })),
        })),
      ]
    : []

  return (
    <>
      <PageHeader
        title="Approvals"
        // Only when the view is narrowed to one location; unset it reads
        // "from every branch", which is what the description says.
        branch={branchName}
        description={
          branchName
            ? 'Everything raised at this location that needs a decision. Nothing goes ahead until somebody signs it off.'
            : 'Everything from every branch that needs a decision. Nothing goes ahead until somebody signs it off.'
        }
        actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="approvals" /> : null}
      />
      <div className="space-y-5">
        <ApprovalFilters
          locations={locations.map((l) => ({ id: l.id, name: l.name }))}
          staff={staff.map(person)}
          // Only kinds that something actually raises. Stock adjustments,
          // purchase orders and price overrides have their own queues and
          // never create a request of this table's kind; a filter for them
          // matched nothing and looked broken.
          kinds={[
            { value: 'STOCK_TRANSFER', label: 'Stock transfer' },
            { value: 'REFUND', label: 'Refund' },
            { value: 'DISCOUNT', label: 'Discount' },
            { value: 'STOCK_WRITEOFF', label: 'Stock write-off' },
          ]}
          statuses={[
            { value: 'PENDING', label: 'Waiting' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'REJECTED', label: 'Rejected' },
            { value: 'WITHDRAWN', label: 'Cancelled' },
          ]}
        />

        <CentralApprovals
          rows={rows}
          currency={restaurant.currency as CurrencyCode}
          timeZone={restaurant.timezone}
          locale={locale}
          filtered={filtered}
        />

        {manages && accessRows.length > 0 ? (
          <ApprovalAccess rows={accessRows} staff={canApproveHere.map(person)} />
        ) : null}

        {filters.status === 'PENDING' ? null : (
          <ApprovalQueue rows={history} currency={restaurant.currency} locale={locale} />
        )}
      </div>
    </>
  )
}
