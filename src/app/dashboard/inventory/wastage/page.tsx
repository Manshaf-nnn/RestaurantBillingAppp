import Link from 'next/link'
import type { Metadata } from 'next'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { WastageBoard, type WastageRow } from '@/features/inventory/components/wastage-board'
import { getWastageReport, WASTAGE_REASON_LABELS } from '@/features/inventory/wastage'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can} from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Wastage' }

export default async function WastagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.INVENTORY_WASTAGE, '/dashboard/inventory/wastage')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const period = params.period === 'WEEK' || params.period === 'MONTH' ? params.period : 'DAY'
  const canApprove = can(user, PERMISSIONS.INVENTORY_WASTAGE_APPROVE)

  const [items, records, report] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true, quantity: true },
      orderBy: { name: 'asc' },
    }),
    prisma.wastageRecord.findMany({
      where: { restaurantId: user.restaurantId },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: {
        item: { select: { name: true, unit: true } },
        createdBy: { select: { name: true } },
        approvedBy: { select: { name: true } },
      },
    }),
    getWastageReport({
      restaurantId: user.restaurantId,
      period,
      // Naming who wasted what is sensitive; only managers see it.
      includeEmployees: canApprove,
    }),
  ])

  const rows: WastageRow[] = records.map((r) => ({
    id: r.id,
    itemName: r.item.name,
    quantity: r.quantityEntered ?? r.quantity,
    unit: (r.enteredUnit ?? r.item.unit) as string,
    reason: r.reason,
    reasonLabel: WASTAGE_REASON_LABELS[r.reason],
    notes: r.reasonNote ?? r.notes,
    costValue: r.costValue,
    status: r.status,
    createdByName: r.createdBy?.name ?? null,
    approvedByName: r.approvedBy?.name ?? null,
    createdAt: r.createdAt.toISOString(),
  }))

  const label = period === 'DAY' ? 'today' : period === 'WEEK' ? 'this week' : 'this month'

  return (
    <>
      <PageHeader
        title="Wastage"
        description="What went in the bin, why, and what it cost. Never counted as a sale."
      />

      {/* <Link>, not <a> — see the note on the variance report's chips. */}
      <div className="mb-5 flex gap-2">
        {(['DAY', 'WEEK', 'MONTH'] as const).map((p) => (
          <Link
            key={p}
            href={`/dashboard/inventory/wastage?period=${p}`}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              period === p ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
            }`}
          >
            {p === 'DAY' ? 'Today' : p === 'WEEK' ? 'Last 7 days' : 'Last month'}
          </Link>
        ))}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label={`Wasted ${label}`} value={money(report.totalValue)} />
        <StatCard label="Records" value={String(report.totalRecords)} />
        <StatCard
          label="Biggest cause"
          value={report.byReason[0] ? `${report.byReason[0].label} (${report.byReason[0].share}%)` : '—'}
        />
      </div>

      {report.byReason.length > 0 && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <SectionCard title="By reason" description={`Where the money went ${label}.`}>
            <ul className="space-y-2">
              {report.byReason.map((r) => (
                <li key={r.reason}>
                  <div className="flex justify-between text-sm">
                    <span>{r.label}</span>
                    <span className="tabular-nums">{money(r.value)} · {r.share}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${r.share}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard title="Most wasted items">
            <ul className="divide-y divide-border">
              {report.topItems.slice(0, 8).map((i) => (
                <li key={i.itemId} className="flex justify-between py-2 text-sm">
                  <span>{i.name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round(i.quantity * 100) / 100} {i.unit.toLowerCase()} · {money(i.value)}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>

          {report.byBranch.length > 1 && (
            <SectionCard title="By branch">
              <ul className="divide-y divide-border">
                {report.byBranch.map((b) => (
                  <li key={b.branchId ?? 'none'} className="flex justify-between py-2 text-sm">
                    <span>{b.name}</span>
                    <span className="tabular-nums">{money(b.value)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {canApprove && report.byEmployee.length > 0 && (
            <SectionCard
              title="By employee"
              description="Visible to managers only. High numbers usually mean a process problem, not a person problem."
            >
              <ul className="divide-y divide-border">
                {report.byEmployee.map((e) => (
                  <li key={e.userId ?? 'none'} className="flex justify-between py-2 text-sm">
                    <span>{e.name}</span>
                    <span className="tabular-nums">{money(e.value)} · {e.count}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </div>
      )}

      <WastageBoard
        items={items}
        rows={rows}
        currency={restaurant.currency}
        canApprove={canApprove}
      />
    </>
  )
}
