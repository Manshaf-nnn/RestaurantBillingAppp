import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { PettyCashConsole } from '@/features/pettycash/components/petty-cash-console'
import { getPettyCashPageData } from '@/features/pettycash/queries'
import { getApprovalPolicy } from '@/features/approvals/service'
import { resolveRange, type RangePreset } from '@/features/reports/range'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import type { PettyCashStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Petty cash' }

const STATUSES = new Set<PettyCashStatus>([
  'DRAFT',
  'PENDING',
  'APPROVED',
  'PAID',
  'REJECTED',
  'CANCELLED',
])

export default async function PettyCashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PETTY_CASH_VIEW, '/dashboard/petty-cash')
  const params = await searchParams

  const restaurant = await requireRestaurant(user.restaurantId)
  const policy = await getApprovalPolicy(user.restaurantId)

  const selection = await selectedBranch(user, params)

  /*
   * The same range vocabulary as every other report screen — `?preset=`,
   * `?from=`, `?to=` — and the restaurant's own timezone, without which
   * "today" is the server's day and every boundary lands 5½ hours out.
   */
  const range = resolveRange({
    preset: (typeof params.preset === 'string' ? params.preset : 'THIS_MONTH') as RangePreset,
    from: typeof params.from === 'string' ? params.from : undefined,
    to: typeof params.to === 'string' ? params.to : undefined,
    timeZone: restaurant.timezone,
  })

  const status =
    typeof params.status === 'string' && STATUSES.has(params.status as PettyCashStatus)
      ? (params.status as PettyCashStatus)
      : null

  const data = await getPettyCashPageData({
    restaurantId: user.restaurantId,
    userId: user.id,
    currency: restaurant.currency,
    approvalThreshold: policy.pettyCashApprovalAbove,
    canRequest: can(user, PERMISSIONS.PETTY_CASH_REQUEST),
    canApprove: can(user, PERMISSIONS.PETTY_CASH_APPROVE),
    branchId: scopeToOne(selection),
    branchIds: selection.branchIds,
    status,
    from: range.from,
    to: range.to,
  })

  return (
    <>
      <PageHeader
        title="Petty cash"
        description="A controlled fund for small cash expenses — raised, approved, then paid."
      />
      <ReportFilters
        preset={range.preset}
        from={range.from.toISOString().slice(0, 10)}
        to={range.to.toISOString().slice(0, 10)}
        locations={data.branches.map((b) => ({ id: b.id, name: b.name }))}
        branchId={scopeToOne(selection) ?? ''}
      />
      <PettyCashConsole data={data} />
    </>
  )
}
