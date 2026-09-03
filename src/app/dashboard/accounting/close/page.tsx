import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { CloseMonthButton } from '@/features/accounting/components/close-month'
import { InfoTip } from '@/features/accounting/components/info-tip'
import { getMonthCloseChecklist } from '@/features/accounting/month-close'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Close month' }

/** Last month, in YYYY-MM — the month an accountant is usually closing. */
function defaultMonth(): string {
  const now = new Date()
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Close Month (acCal.md §13): the checklist, the readiness figure, and one
 * button. Every item is answered by the records, not by a person ticking it.
 */
export default async function CloseMonthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/close')
  const restaurant = await requireRestaurant(user.restaurantId)

  const params = await searchParams
  const raw = typeof params.month === 'string' ? params.month : ''
  const month = /^\d{4}-\d{2}$/.test(raw) ? raw : defaultMonth()
  const selection = await selectedBranch(user, params)

  const checklist = await getMonthCloseChecklist({
    restaurantId: user.restaurantId,
    month,
    timeZone: restaurant.timezone,
    branchIds: selection.branchIds,
  })
  const outstanding = checklist.items.filter((item) => !item.done)
  const canClose = can(user, PERMISSIONS.ACCOUNTING_CLOSE)

  // The previous and next month, for the two arrows.
  const shift = (delta: number) => {
    const [year, monthPart] = month.split('-').map(Number)
    const moved = new Date(Date.UTC(year, monthPart - 1 + delta, 1))
    return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}`
  }

  return (
    <>
      <PageHeader
        title="Close month"
        description={`${checklist.month.label} · ${checklist.readyPercent}% ready to close`}
        actions={
          canClose ? (
            <CloseMonthButton
              month={month}
              monthLabel={checklist.month.label}
              readyPercent={checklist.readyPercent}
              outstanding={outstanding.map((item) => item.label)}
              closedPeriodId={checklist.closedPeriodId}
            />
          ) : null
        }
      />

      <div className="mb-4 flex items-center gap-2 text-sm">
        <Link href={`/dashboard/accounting/close?month=${shift(-1)}`} className="rounded-lg border px-3 py-1.5 hover:bg-muted/50">
          ← {shift(-1)}
        </Link>
        <span className="font-medium">{checklist.month.label}</span>
        <Link href={`/dashboard/accounting/close?month=${shift(1)}`} className="rounded-lg border px-3 py-1.5 hover:bg-muted/50">
          {shift(1)} →
        </Link>
        <InfoTip term="closeMonth" />
      </div>

      {checklist.closedPeriodId ? (
        <div className="mb-4 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm">
          <strong>This month is closed.</strong> The orders and payments inside it refuse edits. Corrections
          are made with new entries dated today — that is how accounting corrections work.
        </div>
      ) : null}

      <SectionCard
        title="Before you close"
        description="Each line is answered by your records, live. Nothing here is a tick-box."
      >
        <ul className="divide-y text-sm">
          {checklist.items.map((item) => (
            <li key={item.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {item.done ? '✓ ' : '⚠ '}
                  {item.label}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
              </div>
              <span className="flex items-center gap-3">
                <Badge variant={item.done ? 'secondary' : 'outline'}>{item.done ? 'Clear' : `${item.count} to do`}</Badge>
                {!item.done ? (
                  <Link href={item.href} className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                    Fix →
                  </Link>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={checklist.readyPercent === 100 ? 'h-full bg-success' : 'h-full bg-warning'}
            style={{ width: `${checklist.readyPercent}%` }}
          />
        </div>
        <p className="mt-2 text-sm font-medium">{checklist.readyPercent}% ready to close</p>
      </SectionCard>
    </>
  )
}
