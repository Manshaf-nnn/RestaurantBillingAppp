import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { HandoverBoard } from '@/features/handover/components/handover-board'
import { CashHandoverLog } from '@/features/handover/components/cash-handover-log'
import { listShiftNotes } from '@/features/handover/queries'
import { listHandovers } from '@/features/handover/cash-service'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Shift handover' }

export default async function HandoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.HANDOVER_VIEW, '/dashboard/handover')

  /*
   * `branchIds`, not `scopeToOne`. A handover board is one of the few screens
   * where an owner viewing "All locations" genuinely wants every site's notes
   * in one list — that is the morning read-through. A branch manager still gets
   * only their own, because `selectedBranch` has already narrowed the list to
   * what they may see.
   */
  const selection = await selectedBranch(user, await searchParams)

  const [notes, restaurant, handovers] = await Promise.all([
    listShiftNotes(user.restaurantId, selection.branchIds),
    requireRestaurant(user.restaurantId),
    /*
     * The cash side of a handover, alongside the notes side. They are the same
     * event from a staff member's point of view — "I am going home, here is
     * what you need to know and here is the till" — and splitting them across
     * two screens is how one half stops being filled in.
     */
    listHandovers({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      limit: 30,
    }),
  ])

  return (
    <>
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Shift handover"
        description="Leave notes for the next shift, and pass the till on with both counts recorded."
      />
      <div className="space-y-6">
        <CashHandoverLog
          currency={restaurant.currency}
          rows={handovers.map((h) => ({
            id: h.id,
            fromName: h.fromUser?.name ?? 'Unknown',
            toName: h.toUser?.name ?? 'Unknown',
            branchName: h.branch?.name ?? null,
            registerName: h.register?.name ?? null,
            expectedAmount: h.expectedAmount,
            countedAmount: h.countedAmount,
            variance: h.variance,
            note: h.note,
            status: h.status,
            createdAt: h.createdAt.toISOString(),
            acceptedAt: h.acceptedAt?.toISOString() ?? null,
          }))}
        />
        <HandoverBoard initial={notes} />
      </div>
    </>
  )
}
