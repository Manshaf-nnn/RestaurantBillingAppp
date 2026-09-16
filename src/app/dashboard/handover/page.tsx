import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { HandoverBoard } from '@/features/handover/components/handover-board'
import { CashHandoverLog } from '@/features/handover/components/cash-handover-log'
import { listShiftNotes } from '@/features/handover/queries'
import { OutstandingTasks } from '@/features/handover/components/outstanding-tasks'
import { listInstructions } from '@/features/instructions/service'
import { listHandovers } from '@/features/handover/cash-service'
import { ShiftHandoverPanel } from '@/features/handover/components/shift-handover'
import { listShiftHandovers } from '@/features/handover/shift-service'
import { localeForCurrency } from '@/lib/money'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can } from '@/lib/rbac'
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

  /*
   * Who may read the whole floor's handovers (correctionA.md §11's rule,
   * carried to the shift handover): somebody who manages staff or drawers.
   * Everyone else sees the ones they were part of.
   */
  const seesAll = can(user, PERMISSIONS.CASH_DRAWER_MANAGE) || can(user, PERMISSIONS.STAFF_MANAGE)

  const [notes, restaurant, handovers, tasks, shiftHandovers, waiting] = await Promise.all([
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
      /*
       * correctionA.md §11 — the history each reader is entitled to. A
       * manager reconciling the floor sees every handover; a cashier sees the
       * ones they were part of. Showing a cashier the whole branch's would
       * publish who was short and by how much to everybody who works there.
       */
      participantId: can(user, PERMISSIONS.CASH_DRAWER_MANAGE) ? undefined : user.id,
    }),
    /*
     * What is still open here (correctionA.md §11).
     *
     * `listInstructions` already filters by what this person may see, so the
     * handover cannot become a way to read another location's instructions —
     * the same list, on the one screen where somebody about to go home will
     * actually read it.
     */
    listInstructions({
      restaurantId: user.restaurantId,
      user,
      branchId: scopeToOne(selection),
      status: 'OPEN',
      limit: 20,
    }),
    // recorrection.md §2 — the shift handover for every role.
    listShiftHandovers({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      participantId: seesAll ? undefined : user.id,
      limit: 40,
    }),
    // Waiting on THIS person, whatever the switcher says: a handover to you
    // is yours to answer wherever you are standing.
    listShiftHandovers({ restaurantId: user.restaurantId, participantId: user.id, status: 'PENDING_ACCEPTANCE', limit: 10 }),
  ])
  const forMe = waiting.filter((row) => row.toId === user.id)
  const mine = waiting.find((row) => row.fromId === user.id) ?? null
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  return (
    <>
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Shift handover"
        description="Hand your shift to whoever is taking over — with your till, if you have one — and leave notes for the next shift."
      />
      <div className="space-y-6">
        <ShiftHandoverPanel
          viewerId={user.id}
          viewerName={user.name}
          waiting={forMe}
          mine={mine}
          history={shiftHandovers}
          canCancelOthers={seesAll}
          currency={restaurant.currency}
          locale={locale}
          branchId={scopeToOne(selection) === '__none__' ? null : scopeToOne(selection)}
        />
        {/*
          Above the till log: the things somebody has to SAY before they leave
          come before the record of what was counted.
        */}
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
