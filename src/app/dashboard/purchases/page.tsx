import type { Metadata } from 'next'
import Link from 'next/link'
import { FileText, PackageCheck, Plus, ShoppingCart, TrendingDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { PurchasesBoard } from '@/features/purchasing/components/purchases-board'
import { getPurchaseBoard } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { viewByKey } from '@/features/purchasing/status'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
import { branchNameFor, scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchasing' }

/**
 * Purchase requests and purchase orders — one list.
 *
 * A request becomes the order when it is approved, so they are one row with
 * one number from start to finish.
 *
 * ── Laid out as Transfers is ────────────────────────────────────────────────
 *
 * This was two rails of status pills over a flat list capped at fifty rows.
 * It is now what the Transfers screen is: five figures, one filter bar, one
 * paged table — the same screen about a different movement, so somebody who
 * can read one can read the other. What did not change is everything
 * underneath: statuses, transitions and permissions still belong to the
 * purchasing service, reached through the order's own page.
 *
 * An old `?view=` link (the rails) still resolves to the same set of statuses.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_VIEW, '/dashboard/purchases')
  const restaurant = await requireRestaurant(user.restaurantId)
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  /*
   * `visibleBranchIds` decides what exists for this person at all, and the
   * switcher narrows within it — the same two steps the Transfers page takes.
   */
  const selection = await selectedBranch(user, params)
  const reach = visibleBranchIds(user)
  const branchIds = selection.branchId ? [selection.branchId] : reach
  // With a location chosen: what that location — not the group — is short of.
  const branchId = scopeToOne(selection)
  const view = viewByKey(one('view') ?? undefined)

  const filtered = ['search', 'supplier', 'status', 'location', 'item', 'priority', 'from', 'to', 'view'].some(
    (key) => one(key) !== null,
  )

  const [board, suggestions, branchName, suppliers, branches, items] = await Promise.all([
    getPurchaseBoard({
      restaurantId: user.restaurantId,
      branchIds,
      filter: {
        search: one('search') ?? undefined,
        supplierId: one('supplier'),
        status: one('status'),
        statuses: one('status') ? null : view?.statuses ?? null,
        branchId: one('location'),
        itemId: one('item'),
        priority: one('priority'),
        from: one('from'),
        to: one('to'),
        page: Number(one('page') ?? '1') || 1,
        perPage: 10,
      },
    }),
    getReorderSuggestions({ restaurantId: user.restaurantId, branchId }),
    branchNameFor(user.restaurantId, selection.branchId),
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
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
  const money = (m: number) => formatMoney(m, restaurant.currency, locale)

  return (
    <>
      <PageHeader
        title="Purchasing"
        branch={branchName}
        icon={<ShoppingCart className="size-6" />}
        description="Request and get approval before purchasing. Stock only moves when goods arrive."
        actions={
          <>
            {can(user, PERMISSIONS.REPORT_PURCHASING) ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/reports/purchasing">
                  <FileText /> Report
                </Link>
              </Button>
            ) : null}
            {can(user, PERMISSIONS.PURCHASE_RECEIVE) ? (
              <Button variant="outline" asChild>
                <Link href="/dashboard/purchases/receive">
                  <PackageCheck /> Receive goods
                </Link>
              </Button>
            ) : null}
            {can(user, PERMISSIONS.PURCHASE_CREATE) ? (
              <Button asChild>
                <Link href="/dashboard/purchases/new">
                  <Plus /> New PO request
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <PurchasesBoard
        rows={board.rows}
        total={board.total}
        page={board.page}
        perPage={board.perPage}
        pages={board.pages}
        stats={board.stats}
        suppliers={suppliers}
        branches={branches}
        items={items}
        currency={restaurant.currency}
        locale={locale}
        can={{ receive: can(user, PERMISSIONS.PURCHASE_RECEIVE) }}
      />

      {suggestions.length > 0 && !filtered && (
        <SectionCard
          title="Needs ordering"
          description="Items at or below their reorder level, with a suggested quantity to bring them back to par."
          className="mt-4"
          actions={
            <div className="flex items-center gap-2">
              <Badge variant="warning">{suggestions.length}</Badge>
              {can(user, PERMISSIONS.PURCHASE_CREATE) ? (
                <Button size="sm" asChild>
                  <Link href="/dashboard/purchases/new?from=low">Request these</Link>
                </Button>
              ) : null}
            </div>
          }
        >
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[38rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 text-right font-medium">In stock</th>
                  <th className="pb-2 pr-3 text-right font-medium">Reorder at</th>
                  <th className="pb-2 pr-3 text-right font-medium">Suggested</th>
                  <th className="pb-2 pr-3 font-medium">Supplier</th>
                  <th className="pb-2 text-right font-medium">Est. cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {suggestions.map((s) => (
                  <tr key={s.itemId}>
                    <td className="py-2.5 pr-3">
                      <Link href={`/dashboard/inventory/${s.itemId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {s.name}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-destructive">
                      <span className="inline-flex items-center gap-1">
                        <TrendingDown className="h-3.5 w-3.5" />
                        {s.currentQty} {s.unit.toLowerCase()}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {s.reorderLevel}
                      {s.alertBranchName ? <span className="block text-xs">at {s.alertBranchName}</span> : null}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">
                      {s.suggestedQty} {s.unit.toLowerCase()}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">
                      {s.supplierName ?? '—'}
                      {s.leadTimeDays !== null && (
                        <span className="block text-xs">{s.leadTimeDays} day lead time</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{money(s.estimatedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </>
  )
}
