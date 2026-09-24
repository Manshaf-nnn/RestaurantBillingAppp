import type { Metadata } from 'next'
import Link from 'next/link'
import { FileText, Plus, Truck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { TransfersBoard } from '@/features/transfers/components/transfers-board'
import { getTransferBoard } from '@/features/transfers/queries'
import { branchNameFor, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Transfers' }

/**
 * Stock moving between locations.
 *
 * ── The screen was rebuilt; the process was not ─────────────────────────────
 *
 * This used to be four stacked lists — pending approval, pending dispatch,
 * pending receive, closed — filed by status AND by which end the viewer stands
 * at. It is now five figures, one filter bar and one table, which is what an
 * owner asked for and what scales past a few dozen rows.
 *
 * What did NOT change: every status, every transition, every permission and
 * every action still belongs to `features/transfers/service`. The filing rule
 * that answered "is this waiting on ME" survives as `sectionFor`, read per row
 * into a line under it and into a filter chip — losing that would have been
 * losing the only thing the old grouping was for.
 */
export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.TRANSFER_VIEW, '/dashboard/transfers')
  const params = await searchParams

  const one = (key: string) => {
    const value = params[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  /*
   * `visibleBranchIds` decides what exists for this person at all, and the
   * switcher narrows within it. This used to be `scopeToOne`, which answers a
   * different question — "which single branch" — and is the wrong shape now
   * that the screen has its own From and To filters.
   */
  const selection = await selectedBranch(user, params)
  const reach = visibleBranchIds(user)
  const branchIds = selection.branchId
    ? [selection.branchId]
    : reach

  const [board, branchName, branches, items] = await Promise.all([
    getTransferBoard({
      restaurantId: user.restaurantId,
      branchIds,
      filter: {
        search: one('search') ?? undefined,
        fromBranchId: one('fromBranch'),
        toBranchId: one('toBranch'),
        status: one('status'),
        itemId: one('item'),
        from: one('from'),
        to: one('to'),
        page: Number(one('page') ?? '1') || 1,
        perPage: 10,
      },
    }),
    branchNameFor(user.restaurantId, selection.branchId),
    prisma.branch.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        ...(reach === null ? {} : { id: { in: reach } }),
      },
      select: { id: true, name: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  ])

  /*
   * "Waiting on me" is decided in the browser from the same `sectionFor` the
   * old list used, so it needs to know which branches this person stands at.
   * Null means every one.
   */
  const rows =
    one('mine') === '1'
      ? board.rows.filter((row) => {
          const atSource = reach === null || reach.includes(row.fromBranchId)
          const atDestination = reach === null || reach.includes(row.toBranchId)
          if (row.status === 'REQUESTED' || row.status === 'APPROVED') return atSource
          if (row.status === 'DISPATCHED' || row.status === 'IN_TRANSIT' || row.status === 'RECEIVED') {
            return atDestination
          }
          return false
        })
      : board.rows

  /*
   * The filters, carried to the report as they stand.
   * `page` and `mine` are deliberately left behind: the report is not paged,
   * and "waiting on me" is a thing to act on rather than to file.
   */
  const reportQuery: Record<string, string> = {}
  for (const key of ['search', 'fromBranch', 'toBranch', 'status', 'item', 'from', 'to', 'branch']) {
    const value = one(key)
    if (value) reportQuery[key] = value
  }

  return (
    <>
      <PageHeader
        title="Transfers"
        branch={branchName}
        icon={<Truck className="size-6" />}
        description="Track and manage stock movement between your locations."
        actions={
          <>
            {/*
              Report, not Export.
              The export button handed back transfer HEADERS — no items, no
              variance, nobody but the requester — which cannot answer "what
              moved and who signed for it". The report page answers it, shows
              the figures on screen first, prints, and carries the same CSV and
              Excel download inside it. The filters travel in the URL, so the
              report opens on exactly the set that was on screen here.
            */}
            <Button asChild variant="outline" size="sm">
              <Link href={{ pathname: '/dashboard/transfers/report', query: reportQuery }}>
                <FileText /> Report
              </Link>
            </Button>
            {can(user, PERMISSIONS.TRANSFER_REQUEST) ? (
              <Button asChild>
                <Link href="/dashboard/transfers/new">
                  <Plus /> Create New Transfer
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <TransfersBoard
        rows={rows}
        total={board.total}
        page={board.page}
        perPage={board.perPage}
        pages={board.pages}
        stats={board.stats}
        branches={branches}
        items={items}
        reachableBranchIds={reach}
        /*
         * The same rule the actions enforce. Offering Dispatch to the
         * receiving branch and answering the click with "only someone at the
         * sending location can do that" teaches people the app is broken.
         */
        can={{
          dispatch: can(user, PERMISSIONS.TRANSFER_DISPATCH),
          receive: can(user, PERMISSIONS.TRANSFER_RECEIVE),
        }}
      />
    </>
  )
}
