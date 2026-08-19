import type { Metadata } from 'next'
import Link from 'next/link'
import { TrendingDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { listPurchaseOrders } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchasing' }

const STATUS: Record<string, { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }> = {
  DRAFT: { label: 'Draft', variant: 'secondary' },
  PENDING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  ORDERED: { label: 'Ordered', variant: 'secondary' },
  PARTIALLY_RECEIVED: { label: 'Partly received', variant: 'warning' },
  RECEIVED: { label: 'Received', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

export default async function PurchasesPage() {
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_VIEW, '/dashboard/purchases')
  const restaurant = await requireRestaurant(user.restaurantId)
  const [orders, suggestions] = await Promise.all([
    listPurchaseOrders({ restaurantId: user.restaurantId }),
    getReorderSuggestions({ restaurantId: user.restaurantId }),
  ])
  const money = (m: number) => formatMoney(m, restaurant.currency)

  return (
    <>
      <PageHeader
        title="Purchasing"
        description="Orders to suppliers, and what still needs buying. Stock only moves when goods arrive."
      />

      {suggestions.length > 0 && (
        <SectionCard
          title="Needs ordering"
          description="Items at or below their reorder level, with a suggested quantity to bring them back to par."
          actions={<Badge variant="warning">{suggestions.length}</Badge>}
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
                    <td className="py-2.5 pr-3 text-right tabular-nums text-red-600 dark:text-red-400">
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

      <SectionCard title="Purchase orders">
        {orders.length === 0 ? (
          <EmptyState
            title="No purchase orders yet"
            description="Orders you place with suppliers appear here, with what has arrived against each."
          />
        ) : (
          <ul className="divide-y divide-border">
            {orders.map((po) => {
              const status = STATUS[po.status] ?? STATUS.DRAFT
              return (
                <li key={po.id}>
                  <Link
                    href={`/dashboard/purchases/${po.id}`}
                    className="-mx-2 flex flex-wrap items-center gap-3 rounded-lg px-2 py-3 hover:bg-muted"
                  >
                    <span className="font-medium tabular-nums">{po.number}</span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    {po.supplierName && <span className="text-sm">{po.supplierName}</span>}
                    <span className="text-sm text-muted-foreground">
                      {po.lineCount} item{po.lineCount === 1 ? '' : 's'}
                      {po.receivedPercent > 0 && po.receivedPercent < 100 ? ` · ${po.receivedPercent}% in` : ''}
                    </span>
                    <span className="ml-auto flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">
                        <LocalDateTime value={po.createdAt} />
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
