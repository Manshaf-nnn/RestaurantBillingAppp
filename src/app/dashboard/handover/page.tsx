import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { HandoverBoard } from '@/features/handover/components/handover-board'
import { listShiftNotes } from '@/features/handover/queries'
import { OutstandingTasks } from '@/features/handover/components/outstanding-tasks'
import { listInstructions } from '@/features/instructions/service'
import { ShiftPanel } from '@/features/shifts/components/shift-panel'
import { loadShiftPanel } from '@/features/shifts/panel-data'
import { localeForCurrency } from '@/lib/money'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Shift' }

/**
 * The Shift tab (shifthandover.md "UI"): the current shift, the handover,
 * and the histories — the same panel the POS mounts, from the same loader.
 * The route keeps its old name so every link to the handover still lands.
 */
export default async function ShiftPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.HANDOVER_VIEW, '/dashboard/handover')
  const params = await searchParams

  /*
   * `branchIds`, not `scopeToOne`, for the lists. A handover board is one of
   * the few screens where an owner viewing "All locations" genuinely wants
   * every site in one list — that is the morning read-through. A branch
   * manager still gets only their own, because `selectedBranch` has already
   * narrowed the list to what they may see.
   */
  const selection = await selectedBranch(user, params)
  const restaurant = await requireRestaurant(user.restaurantId)

  const [notes, tasks, panel] = await Promise.all([
    listShiftNotes(user.restaurantId, selection.branchIds),
    listInstructions({
      restaurantId: user.restaurantId,
      user,
      branchId: scopeToOne(selection),
      status: 'OPEN',
      limit: 20,
    }),
    loadShiftPanel({ user, timeZone: restaurant.timezone, selection, searchParams: params }),
  ])
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  return (
    <>
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Shift"
        description="Your shift, your handover — with your till, if you have one — and the notes for whoever is next."
      />
      <div className="space-y-6">
        <ShiftPanel
          data={panel}
          viewerId={user.id}
          viewerName={user.name}
          currency={restaurant.currency}
          locale={locale}
        />
        <OutstandingTasks
          tasks={tasks.map((task) => ({
            id: task.id,
            title: task.title,
            priority: task.priority,
            dueAt: task.dueAt?.toISOString() ?? null,
            branchName: task.branch?.name ?? null,
            assigneeName: task.assigneeName,
            mine: task.assigneeId === user.id,
          }))}
        />
        <HandoverBoard initial={notes} />
      </div>
    </>
  )
}
