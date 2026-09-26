import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import {
  ApprovalsDesk,
  type PendingRow,
  type RecordRow,
} from '@/features/approvals/components/approvals-desk'
import {
  REQUEST_TYPES,
  REQUEST_TYPE_HINTS,
  getApprovalsInbox,
  getApprovalsRecord,
  getPendingCountsByType,
  type RequestType,
} from '@/features/accounting/inbox'
import { RESTAURANT_WIDE, getApprovalPolicy } from '@/features/approvals/service'
import { decidabilityFor } from '@/features/approvals/decidability'
import { ApprovalFilters } from '@/features/approvals/components/approval-filters'
import { ApprovalAccess } from '@/features/approvals/components/approval-access'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { ROLE_LABELS, permissionsFor, visibleBranchIds } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { PERMISSIONS, can } from '@/lib/rbac'
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
 * This page asks that question once, in two steps: what KIND of request —
 * stock transfer, money, purchase order, other — and then whether it is
 * still waiting or already settled. It decides nothing itself; every row
 * routes to the guarded action that already owns its queue, so permissions,
 * branch guards and audit stay where they are.
 *
 * Only the chosen tab's queues are read. The transfers tab costs two queries
 * where the old single list cost six, and the counts on the other three tabs
 * are counts, not lists.
 */

function parseType(value: unknown): RequestType | null {
  return typeof value === 'string' && (REQUEST_TYPES as readonly string[]).includes(value)
    ? (value as RequestType)
    : null
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
  const tab: 'pending' | 'record' = str('tab') === 'record' ? 'record' : 'pending'

  /*
   * One set of filters, both lists (recorrection.md §1). Every one is
   * validated or ignored by the service; an unknown status or kind simply
   * does not narrow anything.
   */
  // A date from the URL is a calendar day; the window is its whole day.
  const day = (key: string, end: boolean): Date | undefined => {
    const value = str(key)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
    const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  const baseFilters = {
    status: str('status') || undefined,
    kind: str('kind') || undefined,
    requestedById: str('requestedBy') || undefined,
    fromBranchId: str('fromBranch') || undefined,
    toBranchId: str('toBranch') || undefined,
    from: day('from', false),
    to: day('to', true),
  }
  const filtered = Object.values(baseFilters).some(Boolean)

  /*
   * Which tab. The one the URL asks for, else the first that has anything
   * waiting — landing somebody on an empty Stock transfers tab while three
   * purchase orders sit unread is a desk that hides its own work.
   */
  const counts = await getPendingCountsByType(user.restaurantId, selection.branchIds)
  const type =
    parseType(params.type) ?? REQUEST_TYPES.find((value) => counts[value] > 0) ?? 'TRANSFER'
  const filters = { ...baseFilters, type }

  const [waiting, decided, branchName, locations, policy, staff] = await Promise.all([
    tab === 'pending'
      ? getApprovalsInbox(user.restaurantId, selection.branchIds, filters)
      : Promise.resolve([]),
    tab === 'record'
      ? getApprovalsRecord(user.restaurantId, selection.branchIds, filters)
      : Promise.resolve([]),
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

  const pending: PendingRow[] = waiting.map((item) => {
    /*
     * Whether YOU may decide this depends on who is asking, and services do not
     * read permissions — so it is computed here rather than in the query. The
     * rule itself lives in `features/approvals/decidability`, which is pure and
     * has its own tests.
     */
    const verdict = decidabilityFor(user, item)

    return {
      type: item.type,
      queue: item.queue,
      kind: item.kind,
      id: item.id,
      title: item.title,
      reason: item.reason,
      amount: item.amount,
      branchName: item.branchName,
      requestedByName: item.requestedByName,
      isOwnRequest: verdict.isOwnRequest,
      requestedAt: item.requestedAt.toISOString(),
      reference: item.reference,
      consequence: item.consequence,
      decidable: item.decidable,
      canDecide: verdict.canDecide,
      waitingOn: verdict.waitingOn,
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

  const record: RecordRow[] = decided.map((row) => ({
    type: row.type,
    queue: row.queue,
    id: row.id,
    title: row.title,
    reason: row.reason,
    amount: row.amount,
    branchName: row.branchName,
    requestedByName: row.requestedByName,
    requestedAt: row.requestedAt.toISOString(),
    decidedByName: row.decidedByName,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    outcome: row.outcome,
    decisionNote: row.decisionNote,
    forced: row.forced,
    reference: row.reference,
    href: row.href,
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
   * across every location; the action refuses everyone else.
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
        <ApprovalsDesk
          type={type}
          tab={tab}
          pending={pending}
          record={record}
          counts={counts}
          currency={restaurant.currency as CurrencyCode}
          timeZone={restaurant.timezone}
          locale={locale}
          hint={REQUEST_TYPE_HINTS[type]}
          filtered={filtered}
          filters={
            <ApprovalFilters
              locations={locations.map((l) => ({ id: l.id, name: l.name }))}
              staff={staff.map(person)}
              // Only kinds that something actually raises. Stock adjustments
              // and price overrides have their own queues and never create a
              // request of this table's kind; a filter for them matched
              // nothing and looked broken.
              kinds={[
                { value: 'STOCK_TRANSFER', label: 'Stock transfer' },
                { value: 'PURCHASE_ORDER', label: 'Purchase order' },
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
          }
        />

        {manages && accessRows.length > 0 ? (
          <ApprovalAccess rows={accessRows} staff={canApproveHere.map(person)} />
        ) : null}
      </div>
    </>
  )
}
