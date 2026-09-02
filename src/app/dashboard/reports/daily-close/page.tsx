import type { Metadata } from 'next'

import { DailyCloseView } from '@/features/accounting/components/daily-close-view'
import { runIntegrityChecks } from '@/features/accounting/integrity'
import { buildDailySnapshot, businessDateOf, type DailyCloseSnapshot } from '@/features/accounting/service'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { can, PERMISSIONS } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Daily close' }

/**
 * The accountant's day, signed off (§50–51, §59).
 *
 * A business day does not end when the clock does — it ends when somebody
 * responsible looks at the figures and signs them. This screen lists recent
 * days with their live figures, closes them into frozen snapshots, and seals
 * signed ranges into accounting periods the rest of the product refuses to
 * edit into.
 */
export default async function DailyClosePage() {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VIEW, '/dashboard/reports/daily-close')
  const restaurant = await requireRestaurant(user.restaurantId)

  const today = businessDateOf(new Date(), restaurant.timezone)
  const days: Array<{ date: string; closed: boolean; snapshot: DailyCloseSnapshot }> = []

  const closes = await prisma.dailyClose.findMany({
    where: { restaurantId: user.restaurantId, branchId: null },
    orderBy: { businessDate: 'desc' },
    take: 30,
  })
  const closedByDate = new Map(closes.map((row) => [row.businessDate.toISOString().slice(0, 10), row]))

  /*
   * The last seven days, each either its FROZEN snapshot (the record, exactly
   * as signed) or the live figures a close would freeze right now. Reading
   * the stored snapshot for closed days is the point: if the two ever
   * differed, the snapshot is what the accountant filed.
   */
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(today.getTime() - i * 86_400_000)
    const key = date.toISOString().slice(0, 10)
    const stored = closedByDate.get(key)
    if (stored) {
      days.push({ date: key, closed: true, snapshot: stored.snapshot as unknown as DailyCloseSnapshot })
    } else {
      days.push({
        date: key,
        closed: false,
        snapshot: await buildDailySnapshot({
          restaurantId: user.restaurantId,
          businessDate: date,
          timeZone: restaurant.timezone,
        }),
      })
    }
  }

  const integrity = await runIntegrityChecks(user.restaurantId)

  const periods = await prisma.accountingPeriod.findMany({
    where: { restaurantId: user.restaurantId },
    orderBy: { periodStart: 'desc' },
    take: 20,
  })

  return (
    <>
      <PageHeader
        title="Daily close"
        description="Sign off each day's figures, then seal signed ranges so nothing edits into them."
      />
      <DailyCloseView
        days={days}
        todayKey={today.toISOString().slice(0, 10)}
        periods={periods.map((period) => ({
          id: period.id,
          from: period.periodStart.toISOString().slice(0, 10),
          // Stored exclusive; shown inclusive.
          to: new Date(period.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10),
          status: period.status,
          notes: period.notes,
        }))}
        canClose={can(user, PERMISSIONS.ACCOUNTING_CLOSE)}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
        integrity={integrity}
      />
    </>
  )
}
