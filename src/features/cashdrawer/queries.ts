import 'server-only'

import type { CashDrawerStatus, PettyCashStatus } from '@prisma/client'

import { listBranches, type BranchSummary } from '@/features/branches/service'
import { getFundBalance, listRequests } from '@/features/pettycash/service'
import { listHandoverCandidates, listPendingForUser } from '@/features/handover/cash-service'
import { getApprovalPolicy } from '@/features/approvals/service'
import { denominationsFor } from './denominations'
import { prisma } from '@/server/db/prisma'
import {
  computeDrawerTotals,
  getDrawerSummary,
  getOpenDrawer,
  listDrawerSessions,
  listOpenDrawers,
} from './service'
import { listRegisters } from './registers'

export interface DrawerSessionRow {
  id: string
  sessionNumber: string
  openedAt: string
  closedAt: string | null
  openedByName: string
  closedByName: string | null
  reviewedByName: string | null
  branchName: string | null
  registerName: string | null
  openingFloat: number
  openingPettyCash: number
  expectedCash: number | null
  countedCash: number | null
  variance: number | null
  varianceReason: string | null
  status: CashDrawerStatus
}

export interface PettyRow {
  id: string
  category: string
  description: string
  amount: number
  reference: string | null
  paidFrom: 'DRAWER' | 'PETTY_FUND'
  status: PettyCashStatus
  branchId: string
  branchName: string | null
  requestedByName: string | null
  decidedByName: string | null
  paidByName: string | null
  requestedAt: string
  decidedAt: string | null
  paidAt: string | null
}

export interface HandoverRow {
  id: string
  /** Set when this till change is part of a shift handover, which is where it is accepted. */
  shiftHandoverId: string | null
  fromName: string
  branchName: string | null
  registerName: string | null
  expectedAmount: number
  countedAmount: number
  variance: number
  note: string | null
  createdAt: string
}

export interface OpenDrawerRow {
  id: string
  sessionNumber: string
  openedAt: string
  openedById: string
  openedByName: string
  branchName: string | null
  registerName: string | null
  openingFloat: number
  expectedCash: number
  /** True when this is the viewer's own drawer, which they close normally. */
  mine: boolean
}

export interface DrawerPageData {
  open: Awaited<ReturnType<typeof getDrawerSummary>> | null
  /** The open session's branch and till, for the header. */
  openBranchName: string | null
  openRegisterName: string | null
  recent: DrawerSessionRow[]
  /** Counted, over the threshold, waiting for somebody to sign off. */
  review: DrawerSessionRow[]
  /**
   * Every drawer open right now, for a manager.
   *
   * The reason this exists: a cashier who goes home without closing leaves the
   * till locked, and there was no screen anywhere that showed an open session
   * belonging to somebody else. The data was already being fetched and thrown
   * away by a `status !== 'OPEN'` filter one line into the render.
   */
  openNow: OpenDrawerRow[]
  branches: BranchSummary[]
  registers: Array<{ id: string; name: string; branchId: string; isActive: boolean }>
  /** The tin for the open session, and what is queued against it. */
  petty: {
    balance: Awaited<ReturnType<typeof getFundBalance>> | null
    queue: PettyRow[]
  }
  pendingHandovers: HandoverRow[]
  handoverCandidates: Array<{ id: string; name: string }>
  canManage: boolean
  canApprovePetty: boolean
  /**
   * May open a till (staff.A.md §6). The console shows the Open Drawer form
   * only when this is true; without it somebody with no open session sees why
   * rather than a form that will be refused.
   */
  canOpen: boolean
  currency: string
  /**
   * The gap, in minor units, at which a difference is worth explaining and
   * worth somebody senior seeing.
   *
   * Sent to the browser so the close form stops demanding a sentence for a
   * two-rupee rounding. It used to ask for one at ANY non-zero gap, which is
   * most of why closing a drawer felt like paperwork. Zero means the owner has
   * switched the whole check off in Settings.
   */
  varianceThreshold: number
  /** May sign off a large difference — owner/admin, not manager, by default. */
  canReview: boolean
  /**
   * Whether this viewer was sent the expected cash and the sales that make it
   * up (correctionA.md §4). False for the cashier operating the drawer: those
   * fields are null on `open`, not merely unrendered.
   */
  maySeeReconciliation: boolean
  /** The notes and coins to count, derived from the restaurant's currency. */
  denominations: Array<{ value: number; label: string; kind: 'note' | 'coin' }>
}

function toSessionRow(s: Awaited<ReturnType<typeof listDrawerSessions>>[number]): DrawerSessionRow {
  return {
    id: s.id,
    sessionNumber: s.sessionNumber,
    openedAt: s.openedAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
    openedByName: s.openedBy?.name ?? 'Unknown',
    closedByName: s.closedBy?.name ?? null,
    reviewedByName: s.reviewedBy?.name ?? null,
    branchName: s.branch?.name ?? null,
    registerName: s.register?.name ?? null,
    openingFloat: s.openingFloat,
    openingPettyCash: s.openingPettyCash,
    expectedCash: s.expectedCash,
    countedCash: s.countedCash,
    variance: s.variance,
    varianceReason: s.varianceReason,
    status: s.status,
  }
}

export function toPettyRow(r: Awaited<ReturnType<typeof listRequests>>[number]): PettyRow {
  return {
    id: r.id,
    category: r.category,
    description: r.description,
    amount: r.amount,
    reference: r.reference,
    paidFrom: r.paidFrom,
    status: r.status,
    branchId: r.branchId,
    branchName: r.branch?.name ?? null,
    requestedByName: r.requestedBy?.name ?? null,
    decidedByName: r.decidedBy?.name ?? null,
    paidByName: r.paidBy?.name ?? null,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    paidAt: r.paidAt?.toISOString() ?? null,
  }
}

/**
 * Everything the cash-drawer screen needs in one pass.
 *
 * The caller's own open drawer is loaded in full (it drives the live totals and
 * the close form); other sessions are summarised, since the history table only
 * shows what was counted and whether it balanced.
 *
 * The review queue is a manager's view and is empty for everybody else — a
 * cashier cannot sign off their own variance, so showing them the list would
 * only be a list of things they cannot do.
 */
export async function getDrawerPageData(params: {
  restaurantId: string
  userId: string
  currency: string
  canSeeAll: boolean
  canApprovePetty?: boolean
  canReview?: boolean
  /**
   * May start a session and count an opening float (staff.A.md §6).
   *
   * Absent means no, because the console renders the Open Drawer form from
   * this and a flag that defaults to true would hand the form to every caller
   * that had not been updated. The action refuses regardless.
   */
  canOpen?: boolean
  /** Only tills at this location. Null means every location. */
  branchId?: string | null
  /** What this person may see at all. Null is unrestricted, `[]` is nothing. */
  branchIds?: string[] | null
}): Promise<DrawerPageData> {
  /*
   * `null` is unrestricted and `[]` is "confined with nowhere to look" — two
   * very different things that must never be confused. An ABSENT value is a
   * caller that has not asked to be narrowed, which is the first of those, not
   * the second. Normalised once here because `undefined !== null` quietly put
   * the health check's call into the confined branch and every loader threw.
   */
  const reach = params.branchIds ?? null

  const openSession = await getOpenDrawer(params.restaurantId, params.userId)

  const [open, sessions, review, branches, pendingHandovers, openNow] = await Promise.all([
    openSession ? getDrawerSummary(params.restaurantId, openSession.id) : Promise.resolve(null),
    listDrawerSessions({
      restaurantId: params.restaurantId,
      // A cashier sees their own history; a manager sees the whole floor's.
      userId: params.canSeeAll ? null : params.userId,
      branchId: params.branchId ?? null,
      branchIds: reach,
      limit: 30,
    }),
    params.canSeeAll
      ? listDrawerSessions({
          restaurantId: params.restaurantId,
          status: 'PENDING_REVIEW',
          branchId: params.branchId ?? null,
          branchIds: reach,
          limit: 20,
        })
      : Promise.resolve([]),
    listBranches(params.restaurantId),
    listPendingForUser(params.restaurantId, params.userId),
    params.canSeeAll
      ? listOpenDrawers({
          restaurantId: params.restaurantId,
          branchId: params.branchId ?? null,
          branchIds: reach,
        })
      : Promise.resolve([]),
  ]).then(
    ([open, sessions, review, allBranches, pending, live]) =>
      [
        open,
        sessions,
        review,
        /*
         * Narrowed to what this person may reach. `listBranches` returns the
         * whole restaurant, so the "open your drawer" picker was offering a
         * Kandy cashier the Colombo counter: the action refuses it, but only
         * after they have chosen it, and the list itself told them the names of
         * every site in the business. `null` is unrestricted; `[]` is confined
         * with nowhere to look and correctly leaves the picker empty.
         */
        reach === null ? allBranches : allBranches.filter((b) => reach.includes(b.id)),
        pending,
        live,
      ] as const,
  )

  /*
   * Tills are only needed for the branch a drawer is about to be opened at.
   * Loading every branch's would put another site's counter names on a screen
   * that has no use for them.
   */
  const registerBranchId = openSession?.branchId ?? params.branchId ?? null
  const registers = registerBranchId
    ? await listRegisters({ restaurantId: params.restaurantId, branchId: registerBranchId })
    : []

  const [petty, openNames, candidates] = await Promise.all([
    openSession
      ? Promise.all([
          getFundBalance(params.restaurantId, openSession.id),
          listRequests({
            restaurantId: params.restaurantId,
            branchId: openSession.branchId,
            limit: 25,
          }),
        ]).then(([balance, queue]) => ({ balance, queue: queue.map(toPettyRow) }))
      : Promise.resolve({ balance: null, queue: [] as PettyRow[] }),
    openSession
      ? prisma.cashDrawerSession.findUnique({
          where: { id: openSession.id },
          select: { branch: { select: { name: true } }, register: { select: { name: true } } },
        })
      : Promise.resolve(null),
    openSession
      ? listHandoverCandidates({
          restaurantId: params.restaurantId,
          branchId: openSession.branchId,
          excludeUserId: params.userId,
        })
      : Promise.resolve([]),
  ])

  /*
   * ── What the person closing the drawer is NOT told (correctionA.md §4) ──
   *
   * "Before drawer closure, the cashier MUST NOT see the variance amount. Do
   * not expose expected-vs-actual difference to the cashier."
   *
   * Hiding the variance alone would not do it. Expected cash is
   *
   *     openingFloat + cashSales + cashIn − cashOut
   *
   * so anybody shown those four can compute it, and a count tuned to match is
   * exactly what the count exists to detect. `cashSales` is the term a cashier
   * cannot otherwise know to the rupee, so it goes with `expectedCash`.
   *
   * What stays is everything they entered themselves — the float they opened
   * with, the cash in and out they logged — because that is the other half of
   * what this screen is for, and hiding a number somebody typed an hour ago
   * teaches them the screen is lying rather than that it is careful.
   *
   * Redacted HERE, at the boundary where the object crosses to the browser,
   * rather than in the component: a field that reaches the client is a field
   * that is in the page source whether or not anything renders it.
   *
   * A manager reconciling the floor keeps all of it — §4 asks for exactly that.
   */
  const maySeeReconciliation = (params.canSeeAll ?? false) || (params.canReview ?? false)
  const openForViewer =
    open && !maySeeReconciliation
      ? { ...open, expectedCash: null as unknown as number, cashSales: null as unknown as number }
      : open

  return {
    canReview: params.canReview ?? false,
    /**
     * Whether the figures above were sent at all. The close form reads this
     * to decide between "count and close" and the full reconciliation.
     */
    maySeeReconciliation,
    varianceThreshold: (await getApprovalPolicy(params.restaurantId)).cashVarianceAbove,
    denominations: denominationsFor(params.currency),
    open: openForViewer,
    openBranchName: openNames?.branch?.name ?? null,
    openRegisterName: openNames?.register?.name ?? null,
    branches,
    registers: registers.map((r) => ({
      id: r.id,
      name: r.name,
      branchId: r.branchId,
      isActive: r.isActive,
    })),
    petty,
    pendingHandovers: pendingHandovers.map((h) => ({
      id: h.id,
      shiftHandoverId: h.shiftHandover?.id ?? null,
      fromName: h.fromUser?.name ?? 'A colleague',
      branchName: h.branch?.name ?? null,
      registerName: h.register?.name ?? null,
      expectedAmount: h.expectedAmount,
      countedAmount: h.countedAmount,
      variance: h.variance,
      note: h.note,
      createdAt: h.createdAt.toISOString(),
    })),
    handoverCandidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    openNow: await Promise.all(
      openNow.map(async (row) => ({
        id: row.id,
        sessionNumber: row.sessionNumber,
        openedAt: row.openedAt.toISOString(),
        openedById: row.openedById,
        openedByName: row.openedBy?.name ?? 'Unknown',
        branchName: row.branch?.name ?? null,
        registerName: row.register?.name ?? null,
        openingFloat: row.openingFloat,
        // Live, because a session still taking money has no snapshot yet — and
        // the figure an owner needs before counting it is what it *should*
        // hold right now.
        expectedCash: (await computeDrawerTotals(row.id)).expectedCash,
        mine: row.openedById === params.userId,
      })),
    ),
    canManage: params.canSeeAll,
    canApprovePetty: params.canApprovePetty ?? false,
    canOpen: params.canOpen ?? false,
    currency: params.currency,
    recent: sessions.map(toSessionRow),
    review: review.map(toSessionRow),
  }
}

export { computeDrawerTotals }
