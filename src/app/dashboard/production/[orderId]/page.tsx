import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { acceptableUnits } from '@/features/inventory/units'
import { ProductionOrderPanel } from '@/features/production/components/production-order-panel'
import { getProductionRun } from '@/features/production/queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Production order' }

/**
 * One production order — screens 4 to 6 of the flow (pro.b.md).
 *
 * Step 3 lands here. The kitchen issues the ingredients here (stock leaves,
 * FIFO, lot by lot), completes here (actual output, wastage, actual cost), and
 * sees the finished item in stock here. The traceability panel links here for
 * every "where did this stock come from" trail that ends at a run, so the
 * route outlives the flow above it and reads recipe-era runs too.
 */
export default async function ProductionOrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>
}) {
  const { orderId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PRODUCTION_VIEW,
    `/dashboard/production/${orderId}`,
  )

  const run = await getProductionRun({ restaurantId: user.restaurantId, orderId })
  if (!run) notFound()

  // A run at a branch this person has nothing to do with is not theirs to
  // read, id in the address bar or not.
  if (!canAccessBranch(user, run.branchId)) notFound()

  const [restaurant, item] = await Promise.all([
    requireRestaurant(user.restaurantId),
    run.itemId
      ? prisma.inventoryItem.findFirst({ where: { id: run.itemId, restaurantId: user.restaurantId } })
      : Promise.resolve(null),
  ])
  const money = (m: number) => formatMoney(m, restaurant.currency)
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const unit = (run.unit ?? '').toLowerCase()

  const status =
    run.status === 'CANCELLED'
      ? { label: 'Cancelled', variant: 'destructive' as const }
      : run.status === 'IN_PROGRESS'
        ? { label: run.issued ? 'In Progress · issued' : 'In Progress', variant: 'warning' as const }
        : { label: 'Completed', variant: 'success' as const }

  return (
    <>
      <Link
        href="/dashboard/production"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Kitchen Production
      </Link>

      <PageHeader
        title={`Production Order ${run.number}`}
        description={`${run.itemName} · ${run.branchName}${run.madeBy ? ` · ${run.madeBy}` : ''}`}
        actions={<Badge variant={status.variant}>{status.label}</Badge>}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Recipe" value={run.itemName} />
        <StatCard label="Planned Qty" value={`${run.plannedQty} ${unit}`.trim()} />
        <StatCard
          label="Produced Qty"
          value={run.producedQty !== null && run.status !== 'IN_PROGRESS' ? `${run.producedQty} ${unit}`.trim() : '—'}
          tone={run.status === 'IN_PROGRESS' ? 'default' : 'primary'}
        />
        <StatCard
          label={run.issued ? 'Ingredient cost (FIFO)' : 'Estimated cost (FIFO)'}
          value={money(run.issued ? run.materialCost : run.plan.reduce((sum, line) => sum + line.lineCost, 0))}
          hint={run.status === 'COMPLETED' ? `${money(run.unitCost)} per ${unit || 'unit'}` : undefined}
        />
      </div>

      <ProductionOrderPanel
        run={run}
        units={item ? acceptableUnits(item) : []}
        currency={restaurant.currency}
        locale={locale}
        canManage={can(user, PERMISSIONS.PRODUCTION_MANAGE)}
      />
    </>
  )
}
