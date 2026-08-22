import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { TasksBoard, type TaskView } from '@/features/instructions/components/tasks-board'
import { listInstructions } from '@/features/instructions/service'
import { listLocations } from '@/features/transfers/queries'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Things to do' }

/**
 * The owner's instructions to a location.
 *
 * Built because there was no channel between an owner and their branches. The
 * owner could see every branch's takings and move every branch's stock, and
 * then had to ring someone to say what to do about it — so the app held the
 * facts and the phone held the decisions, and a month later nobody could say
 * whether the stock count they had asked for was ever done.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.DASHBOARD_VIEW, '/dashboard/tasks')

  const selection = await selectedBranch(user, await searchParams)
  const canInstruct = visibleBranchIds(user) === null

  const [instructions, locations] = await Promise.all([
    listInstructions({
      restaurantId: user.restaurantId,
      user,
      branchId: scopeToOne(selection),
    }),
    canInstruct ? listLocations(user.restaurantId, visibleBranchIds(user)) : Promise.resolve([]),
  ])

  const tasks: TaskView[] = instructions.map((i) => ({
    id: i.id,
    title: i.title,
    body: i.body,
    priority: i.priority,
    status: i.status,
    dueAt: i.dueAt?.toISOString() ?? null,
    branchId: i.branchId,
    branchName: i.branch?.name ?? null,
    createdByName: i.createdByName,
    createdAt: i.createdAt.toISOString(),
    doneByName: i.doneByName,
    doneAt: i.doneAt?.toISOString() ?? null,
    doneNote: i.doneNote,
  }))

  return (
    <>
      <AutoRefresh intervalMs={30000} />
      <PageHeader
        title="Things to do"
        description={
          canInstruct
            ? 'Tell a location what needs doing. They are notified, and it stays here until someone says it is done.'
            : 'What the owner has asked for. Tick one off when it is done and your name goes against it.'
        }
      />
      <TasksBoard
        initial={tasks}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
        canInstruct={canInstruct}
      />
    </>
  )
}
