import 'server-only'

import { computeDrawerTotals, getDrawerSummary, getOpenDrawer, listDrawerSessions } from './service'
import { listBranches, type BranchSummary } from '@/features/branches/service'

export interface DrawerPageData {
  open: Awaited<ReturnType<typeof getDrawerSummary>> | null
  recent: Array<{
    id: string
    openedAt: string
    closedAt: string | null
    openedByName: string
    closedByName: string | null
    branchName: string | null
    openingFloat: number
    expectedCash: number | null
    countedCash: number | null
    variance: number | null
    status: 'OPEN' | 'CLOSED'
  }>
  branches: BranchSummary[]
  currency: string
}

/**
 * Everything the cash-drawer screen needs in one pass.
 *
 * The caller's own open drawer is loaded in full (it drives the live totals and
 * the close form); other sessions are summarised, since the history table only
 * shows what was counted and whether it balanced.
 */
export async function getDrawerPageData(params: {
  restaurantId: string
  userId: string
  currency: string
  canSeeAll: boolean
  /** Only tills at this location. Null means every location. */
  branchId?: string | null
}): Promise<DrawerPageData> {
  const openSession = await getOpenDrawer(params.restaurantId, params.userId)

  const [open, sessions, branches] = await Promise.all([
    openSession ? getDrawerSummary(params.restaurantId, openSession.id) : Promise.resolve(null),
    listDrawerSessions({
      restaurantId: params.restaurantId,
      // A cashier sees their own history; a manager sees the whole floor's.
      userId: params.canSeeAll ? null : params.userId,
      branchId: params.branchId ?? null,
      limit: 30,
    }),
    listBranches(params.restaurantId),
  ])

  return {
    open,
    branches,
    currency: params.currency,
    recent: sessions.map((s) => ({
      id: s.id,
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      openedByName: s.openedBy?.name ?? 'Unknown',
      closedByName: s.closedBy?.name ?? null,
      branchName: s.branch?.name ?? null,
      openingFloat: s.openingFloat,
      expectedCash: s.expectedCash,
      countedCash: s.countedCash,
      variance: s.variance,
      status: s.status,
    })),
  }
}

export { computeDrawerTotals }
