import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { HandoverBoard } from '@/features/handover/components/handover-board'
import { listShiftNotes } from '@/features/handover/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Shift handover' }

export default async function HandoverPage() {
  const user = await requirePagePermission(PERMISSIONS.ORDER_VIEW, '/dashboard/handover')
  const notes = await listShiftNotes(user.restaurantId)

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
