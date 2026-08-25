import 'server-only'

import type { PettyCashStatus } from '@prisma/client'

import { listBranches, type BranchSummary } from '@/features/branches/service'
import { getOpenDrawer } from '@/features/cashdrawer/service'
import { toPettyRow, type PettyRow } from '@/features/cashdrawer/queries'
import { prisma } from '@/server/db/prisma'
import { getFundBalance, listRequests, PETTY_CASH_CATEGORIES } from './service'

export interface PettyCashTotals {
  opening: number
  toppedUp: number
  /** Paid out of the tin. */
  spentFromFund: number
  /** Paid out of the drawer — a different pile, reported separately. */
  spentFromDrawer: number
  balance: number
  pendingCount: number
  approvedCount: number
  rejectedCount: number
  paidCount: number
  pendingValue: number
  approvedValue: number
}

export interface PettyCashPageData {
  rows: PettyRow[]
  totals: PettyCashTotals
  branches: BranchSummary[]
  categories: readonly string[]
  /** The caller's open drawer — a request can only be PAID against one. */
  openSession: { id: string; sessionNumber: string; branchId: string } | null
  canRequest: boolean
  canApprove: boolean
  currency: string
  /** Above this, somebody other than the requester has to approve. */
  approvalThreshold: number
}

/**
 * Everything the petty cash screen needs.
 *
 * The totals are computed from the same rows the table shows, filtered the same
 * way, so the summary at the top and the list underneath cannot disagree — the
 * failure that makes a report worthless is a header that was built by a
 * different query from the body.
 */
export async function getPettyCashPageData(params: {
  restaurantId: string
  userId: string
  currency: string
  approvalThreshold: number
  canRequest: boolean
  canApprove: boolean
  branchId?: string | null
  branchIds?: string[] | null
  status?: PettyCashStatus | null
  from?: Date | null
  to?: Date | null
}): Promise<PettyCashPageData> {
  // `null`/absent is unrestricted; `[]` is confined with nowhere to look.
  const reach = params.branchIds ?? null

  const [requests, branches, open] = await Promise.all([
    listRequests({
      restaurantId: params.restaurantId,
      branchId: params.branchId ?? null,
      branchIds: reach,
      status: params.status ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
      limit: 200,
    }),
    // Narrowed to this person's reach — the request form's branch picker must
    // not name sites they cannot see. See the same note in cashdrawer/queries.
    listBranches(params.restaurantId).then((all) =>
      reach === null ? all : all.filter((b) => reach.includes(b.id)),
    ),
    getOpenDrawer(params.restaurantId, params.userId),
  ])

  const balance = open ? await getFundBalance(params.restaurantId, open.id) : null

  const totals: PettyCashTotals = {
    opening: balance?.opening ?? 0,
    toppedUp: balance?.toppedUp ?? 0,
    spentFromFund: 0,
    spentFromDrawer: 0,
    balance: balance?.balance ?? 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    paidCount: 0,
    pendingValue: 0,
    approvedValue: 0,
  }

  for (const r of requests) {
    if (r.status === 'PENDING') {
      totals.pendingCount += 1
      totals.pendingValue += r.amount
    }
    if (r.status === 'APPROVED') {
      totals.approvedCount += 1
      totals.approvedValue += r.amount
    }
    if (r.status === 'REJECTED') totals.rejectedCount += 1
    if (r.status === 'PAID') {
      totals.paidCount += 1
      if (r.paidFrom === 'PETTY_FUND') totals.spentFromFund += r.amount
      else totals.spentFromDrawer += r.amount
    }
  }

  const sessionMeta = open
    ? await prisma.cashDrawerSession.findUnique({
        where: { id: open.id },
        select: { id: true, sessionNumber: true, branchId: true },
      })
    : null

  return {
    rows: requests.map(toPettyRow),
    totals,
    branches,
    categories: PETTY_CASH_CATEGORIES,
    openSession: sessionMeta,
    canRequest: params.canRequest,
    canApprove: params.canApprove,
    currency: params.currency,
    approvalThreshold: params.approvalThreshold,
  }
}
