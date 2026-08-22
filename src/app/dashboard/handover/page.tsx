import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { HandoverBoard } from '@/features/handover/components/handover-board'
import { listShiftNotes } from '@/features/handover/queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Shift handover' }

export default async function HandoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ORDER_VIEW, '/dashboard/handover')

  /*
   * `branchIds`, not `scopeToOne`. A handover board is one of the few screens
   * where an owner viewing "All locations" genuinely wants every site's notes
   * in one list — that is the morning read-through. A branch manager still gets
   * only their own, because `selectedBranch` has already narrowed the list to
   * what they may see.
   */
  const selection = await selectedBranch(user, await searchParams)
  const notes = await listShiftNotes(user.restaurantId, selection.branchIds)

  return (
    <>
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Shift handover"
        description="Leave notes for the next shift — nothing gets forgotten between manager changes."
      />
      <HandoverBoard initial={notes} />
    </>
  )
}
