import type { Metadata } from 'next'
import Link from 'next/link'
import { PackageCheck, Plus, TrendingDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { Button } from '@/components/ui/button'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { listPurchaseOrders } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { ORDER_VIEWS, PO_PRIORITY, PO_STATUS, REQUEST_VIEWS, viewByKey } from '@/features/purchasing/status'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { cn } from '@/lib/utils'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { SearchBox } from '@/components/search-box'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchasing' }

/**
 * Purchase requests and purchase orders — one list, two lenses.
 *
 * A request becomes the order when it is approved, so they are one row with
 * one number from start to finish. The rail across the top files them the way
 * a buyer thinks about them: what is still being decided, and what is on its
 * way in.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_VIEW, '/dashboard/purchases')
  const restaurant = await requireRestaurant(user.restaurantId)

  // With a location chosen: orders being delivered there, and what that
  // location — not the group — is running short of.
  const params = await searchParams
  const search = typeof params.search === 'string' ? params.search : ''
  const viewKey = typeof params.view === 'string' ? params.view : 'all'
  const view = viewByKey(viewKey)
  const branchId = scopeToOne(await selectedBranch(user, params))

  const [orders, suggestions] = await Promise.all([
    listPurchaseOrders({ restaurantId: user.restaurantId, branchId, search, statuses: view?.statuses }),
    getReorderSuggestions({ restaurantId: user.restaurantId, branchId }),
  ])
  const money = (m: number) => formatMoney(m, restaurant.currency)
  const href = (key: string) => `/dashboard/purchases?view=${key}${search ? `&search=${encodeURIComponent(search)}` : ''}`

  return (
    <>
      <PageHeader
        title="Purchasing"
        description="Request and get approval before purchasing. Stock only moves when goods arrive."
        actions={
          <>
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

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <Rail title="Purchase requests" views={REQUEST_VIEWS} active={viewKey} href={href} allHref={href('all')} />
          <Rail title="Purchase orders" views={ORDER_VIEWS} active={viewKey} href={href} />
        </div>
        <div className="w-full max-w-sm">
          <SearchBox placeholder="Order number, supplier, item, GRN or invoice…" defaultValue={search} />
        </div>
      </div>

      {suggestions.length > 0 && !view && (
        <SectionCard
          title="Needs ordering"
          description="Items at or below their reorder level, with a suggested quantity to bring them back to par."
          className="mb-4"
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
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{s.reorderLevel}</td>
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

      <SectionCard title={view?.label ?? 'All purchase requests and orders'} bodyClassName="p-0">
        {orders.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={search ? `Nothing matches “${search}”` : view ? `Nothing ${view.label.toLowerCase()}` : 'No purchase requests yet'}
              description={
                search
                  ? 'Try the order number, the supplier, an item on the order, or a GRN or invoice number.'
                  : 'Raise a request, get it approved, and receive the goods against it. Each step appears here.'
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {orders.map((po) => {
              const status = PO_STATUS[po.status]
              return (
                <li key={po.id}>
                  <Link
                    href={`/dashboard/purchases/${po.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 hover:bg-muted/60"
                  >
                    <span className="font-medium tabular-nums">{po.number}</span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    {po.priority === 'URGENT' ? (
                      <Badge variant={PO_PRIORITY.URGENT.variant}>{PO_PRIORITY.URGENT.label}</Badge>
                    ) : null}
                    {po.supplierName && <span className="text-sm">{po.supplierName}</span>}
                    {po.branchName && !branchId ? <Badge variant="secondary">{po.branchName}</Badge> : null}
                    <span className="text-sm text-muted-foreground">
                      {po.lineCount} item{po.lineCount === 1 ? '' : 's'}
                      {po.createdByName ? ` · ${po.createdByName}` : ''}
                      {po.receivedPercent > 0 && po.receivedPercent < 100 ? ` · ${po.receivedPercent}% in` : ''}
                    </span>
                    <span className="ml-auto flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">
                        {po.expectedAt ? (
                          <>
                            needed <LocalDateTime value={po.expectedAt} />
                          </>
                        ) : (
                          <LocalDateTime value={po.createdAt} />
                        )}
                      </span>
                      <span className="font-semibold tabular-nums">{money(po.total)}</span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>
    </>
  )
}

function Rail({
  title,
  views,
  active,
  href,
  allHref,
}: {
  title: string
  views: Array<{ key: string; label: string }>
  active: string
  href: (key: string) => string
  /** The "everything" pill, shown on the first rail only. */
  allHref?: string
}) {
  const pill = (key: string, label: string) => (
    <Link
      key={key}
      href={href(key)}
      aria-current={active === key ? 'page' : undefined}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active === key
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
      {allHref ? (
        <Link
          href={allHref}
          aria-current={active === 'all' ? 'page' : undefined}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            active === 'all'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-muted-foreground hover:text-foreground',
          )}
        >
          Everything
        </Link>
      ) : null}
      {views.map((view) => pill(view.key, view.label))}
    </div>
  )
}
