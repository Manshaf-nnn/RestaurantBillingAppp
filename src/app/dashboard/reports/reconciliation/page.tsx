import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getReconciliationReport } from '@/features/reports/reconciliation'
import { resolveRange } from '@/features/reports/range'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock reconciliation' }

/**
 * Opening + in − out = closing, per item.
 *
 * The report an owner needs before trusting any other stock figure, and the one
 * that catches a balance changed without a movement behind it.
 */
export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VIEW, '/dashboard/reports/reconciliation')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const preset = typeof params.range === 'string' ? params.range : 'THIS_MONTH'
  const range = resolveRange({ preset: preset as never })

  /*
   * Resolved through the shared helper so the top-bar switcher and this page's
   * own picker always agree, and so a remembered choice survives arriving here
   * from the nav rather than from a link that carries `?branch=`.
   */
  const selection = await selectedBranch(user, params)
  const allowed = selection.branchIds
  const branchId = scopeToOne(selection)

  const locations = (await listSwitchableLocations(user.restaurantId)).filter(
    (l) => allowed === null || allowed.includes(l.id),
  )

  const report = await getReconciliationReport({
    restaurantId: user.restaurantId,
    range,
    branchId,
  })

  const href = (next: { range?: string; branch?: string | null }) => {
    const q = new URLSearchParams()
    q.set('range', next.range ?? preset)
    const b = next.branch === undefined ? branchId : next.branch
    if (b) q.set('branch', b)
    return `/dashboard/reports/reconciliation?${q.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Stock reconciliation"
        description="What you started with, everything that came in and went out, and what should be left. If the books balance, every stock figure in the system can be trusted."
      />

      <div className="mb-5 flex flex-wrap gap-2">
        {(['TODAY', 'THIS_WEEK', 'THIS_MONTH', 'LAST_MONTH'] as const).map((p) => (
          <Link
            key={p}
            href={href({ range: p })}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              preset === p ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:bg-muted'
            }`}
          >
            {p.replace(/_/g, ' ').toLowerCase()}
          </Link>
        ))}
      </div>

      {locations.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2">
          <Link
            href={href({ branch: null })}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              !branchId ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:bg-muted'
            }`}
          >
            All locations
          </Link>
          {locations.map((l) => (
            <Link
              key={l.id}
              href={href({ branch: l.id })}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                branchId === l.id ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:bg-muted'
              }`}
            >
              {l.name}
            </Link>
          ))}
        </div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="Items with movement" value={String(report.totals.items)} />
        <StatCard label="Closing stock value" value={money(report.totals.valueAtCost)} tone="primary" />
        <StatCard
          label="Items that do not balance"
          value={String(report.totals.drifting)}
          tone={report.totals.drifting > 0 ? 'destructive' : 'default'}
        />
      </div>

      {report.balanced ? (
        <div className="mb-5 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <strong>The books balance.</strong> Every item&apos;s closing stock equals its opening
          stock plus everything in, less everything out. Nothing changed a balance without a
          movement behind it.
        </div>
      ) : (
        <div className="mb-5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <strong>{report.totals.drifting} item(s) do not balance.</strong> The stored quantity
          disagrees with the sum of its own movements, which means something changed it directly.
          Every figure derived from those items — value, margin, reorder level — is wrong until it is
          corrected with a stock count.
        </div>
      )}

      {branchId && (
        <p className="mb-5 text-xs text-muted-foreground">
          Showing one location, so the closing figure is what this location&apos;s movements add up
          to. The stored-quantity check only applies across all locations.
        </p>
      )}

      {report.lines.length === 0 ? (
        <SectionCard title="Nothing to reconcile">
          <EmptyState title="No stock movement in this period" description="Choose a wider date range." />
        </SectionCard>
      ) : (
        <div className="space-y-4">
          {report.lines.map((line) => (
            <SectionCard
              key={line.itemId}
              title={line.name}
              actions={
                Math.abs(line.drift) > 1e-6 ? (
                  <Badge variant="destructive">
                    off by {line.drift > 0 ? '+' : ''}{line.drift} {line.unit.toLowerCase()}
                  </Badge>
                ) : (
                  <Badge variant="secondary">balanced</Badge>
                )
              }
            >
              <dl className="space-y-1.5 text-sm">
                <Row label="Opening" value={`${line.opening} ${line.unit.toLowerCase()}`} strong />
                {line.movements.map((m) => (
                  <Row
                    key={m.label}
                    label={m.label}
                    value={`${m.quantity > 0 ? '+' : ''}${m.quantity} ${line.unit.toLowerCase()}`}
                    tone={m.group === 'out' ? 'out' : 'in'}
                  />
                ))}
                <div className="!mt-3 border-t border-border pt-2">
                  <Row
                    label="Closing (per the ledger)"
                    value={`${line.expected} ${line.unit.toLowerCase()}`}
                    strong
                  />
                  {!branchId && Math.abs(line.drift) > 1e-6 && (
                    <Row label="Stored quantity" value={`${line.cached} ${line.unit.toLowerCase()}`} tone="out" />
                  )}
                  <Row label="Value at cost" value={money(line.valueAtCost)} />
                </div>
              </dl>
            </SectionCard>
          ))}
        </div>
      )}
    </>
  )
}

function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string
  value: string
  tone?: 'in' | 'out'
  strong?: boolean
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</dt>
      <dd
        className={`tabular-nums ${strong ? 'font-medium' : ''} ${
          tone === 'in' ? 'text-emerald-600 dark:text-emerald-400'
            : tone === 'out' ? 'text-amber-600 dark:text-amber-400' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
