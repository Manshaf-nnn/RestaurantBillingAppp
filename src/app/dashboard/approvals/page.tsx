import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ApprovalQueue, type ApprovalRow } from '@/features/approvals/components/approval-queue'
import { listApprovals } from '@/features/approvals/service'
import { PERMISSIONS, visibleBranchIds, can} from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Approvals' }

export default async function ApprovalsPage() {
  const user = await requirePagePermission(PERMISSIONS.DASHBOARD_VIEW, '/dashboard/approvals')
  const restaurant = await requireRestaurant(user.restaurantId)

  // Someone confined to a location only sees requests raised there.
  const branchIds = visibleBranchIds({ role: user.role, branchId: user.branchId })

  const approvals = await listApprovals({
    restaurantId: user.restaurantId,
    branchIds,
    limit: 60,
  })

  const rows: ApprovalRow[] = approvals.map((a) => ({
    id: a.id,
    kind: a.kind,
    status: a.status,
    entity: a.entity,
    amount: a.amount,
    reason: a.reason,
    requestedByName: a.requestedBy?.name ?? null,
    decidedByName: a.decidedBy?.name ?? null,
    branchName: a.branch?.name ?? null,
    requestedAt: a.requestedAt.toISOString(),
    decisionNote: a.decisionNote,
  }))

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Actions above your thresholds wait here. Nothing goes ahead until someone signs it off."
      />
      <ApprovalQueue
        rows={rows}
        currency={restaurant.currency}
        canDecide={can(user, PERMISSIONS.SETTINGS_MANAGE)}
      />
    </>
  )
}
