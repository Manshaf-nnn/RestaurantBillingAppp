import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { ReportTable } from '@/features/reports/components/report-table'
import { LocalDateTime } from '@/components/local-time'
import { resolveRange, RANGE_LABELS, type RangePreset } from '@/features/reports/range'
import {
  getBranchAttendance,
  getBranchStaffActivity,
  getBranchStaffPerformance,
} from '@/features/staff/performance'
import { ShiftCorrection } from '@/features/attendance/components/shift-correction'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Staff at this location' }

const VIEWS = ['attendance', 'performance', 'activity'] as const
type View = (typeof VIEWS)[number]

const PRESETS: RangePreset[] = ['TODAY', 'YESTERDAY', 'LAST_7', 'THIS_MONTH', 'LAST_30']

/**
 * Who worked here, what they did, and what it added up to.
 *
 * ── Why this is its own route ───────────────────────────────────────────────
 *
 * The location page is a stack of cards that fetches five queries before it
 * checks `canAccessBranch`. Today that only wastes a query; adding hours and
 * pay-adjacent figures to it would mean reading another branch's attendance
 * before deciding whether the reader may see that branch. This page checks
 * first. It also needs a date range, and the location page takes no
 * `searchParams` at all.
 *
 * Guarded on STAFF_VIEW rather than BRANCH_VIEW, which is also the right
 * meaning: switching **Staff** off for a role should hide staff hours, not
 * switching **Locations** off.
 *
 * ── Three views, one at a time ──────────────────────────────────────────────
 *
 * `?view=` rather than client tabs, because a client tab component would make
 * the server render all three sections' queries on every visit to show one of
 * them. It also makes a particular week at a particular branch a link somebody
 * can send to their accountant.
 */
export default async function BranchStaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ branchId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { branchId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.STAFF_VIEW,
    `/dashboard/locations/${branchId}/staff`,
  )

  // Before anything is read. STAFF_VIEW says "may see staff"; it does not say
  // which location's, and the id came from the URL.
  if (!canAccessBranch(user, branchId)) notFound()

  const [restaurant, branch] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.branch.findFirst({
      where: { id: branchId, restaurantId: user.restaurantId, deletedAt: null },
      select: { id: true, name: true },
    }),
  ])
  if (!branch) notFound()

  const query = await searchParams
  const view: View = VIEWS.includes(query.view as View) ? (query.view as View) : 'attendance'
  const range = resolveRange({
    preset: (typeof query.preset === 'string' ? query.preset : 'LAST_7') as RangePreset,
    from: typeof query.from === 'string' ? query.from : undefined,
    to: typeof query.to === 'string' ? query.to : undefined,
    timeZone: restaurant.timezone,
  })

  /*
   * Everyone's figures, or only your own.
   *
   * Identity, not authority — there is no "see my own performance" permission
   * to grant or forget. A waiter opening this page sees their own row; a
   * manager sees the branch. `mine` is null when they may see everyone.
   */
  const seesEveryone = can(user, PERMISSIONS.STAFF_MANAGE) || can(user, PERMISSIONS.ANALYTICS_VIEW)
  const mine = seesEveryone ? undefined : user.id
  const canCorrect = can(user, PERMISSIONS.STAFF_MANAGE)

  const money = (m: number) => formatMoney(m, restaurant.currency, restaurant.locale)
  const href = (next: Partial<{ view: string; preset: string }>) => {
    const sp = new URLSearchParams()
    sp.set('view', next.view ?? view)
    sp.set('preset', next.preset ?? range.preset)
    return `/dashboard/locations/${branchId}/staff?${sp.toString()}`
  }

  return (
    <>
      <PageHeader
        title={`Staff · ${branch.name}`}
        description={
          seesEveryone
            ? 'Everyone who worked at this location, and what they did here.'
            : 'Your own hours and figures at this location.'
        }
        actions={
          <Link
            href={`/dashboard/locations/${branchId}`}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Back to the location
          </Link>
        }
      />

      {/*
        <Link>, not <a>. A bare anchor tears the whole application down and
        rebuilds it to change one query parameter — the same "it reloads by
        itself" the reports pages hit.
      */}
      <div className="mb-4 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={href({ view: v })}
            className={`rounded-lg border px-3 py-1.5 text-sm capitalize ${
              view === v
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border hover:bg-muted'
            }`}
          >
            {v}
          </Link>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Link
            key={p}
            href={href({ preset: p })}
            className={`rounded-lg border px-2.5 py-1 text-xs ${
              range.preset === p
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {RANGE_LABELS[p]}
          </Link>
        ))}
      </div>

      {view === 'attendance' ? (
        <Attendance
          restaurantId={user.restaurantId}
          branchId={branchId}
          range={range}
          userId={mine}
          canCorrect={canCorrect}
        />
      ) : view === 'performance' ? (
        <Performance
          restaurantId={user.restaurantId}
          branchId={branchId}
          range={range}
          userId={mine}
          currency={restaurant.currency}
          locale={restaurant.locale}
          money={money}
        />
      ) : (
        <Activity
          restaurantId={user.restaurantId}
          branchId={branchId}
          range={range}
          userId={mine}
        />
      )}
    </>
  )
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

async function Attendance({
  restaurantId,
  branchId,
  range,
  userId,
  canCorrect,
}: {
  restaurantId: string
  branchId: string
  range: ReturnType<typeof resolveRange>
  userId?: string
  canCorrect: boolean
}) {
  const { rows, totalMinutes, onShiftNow } = await getBranchAttendance({
    restaurantId,
    branchId,
    range,
    userId,
  })

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="On shift now" value={onShiftNow} />
        <StatCard label="People" value={rows.length} />
        <StatCard label="Hours" value={hhmm(totalMinutes)} hint={range.label} />
      </div>

      <SectionCard
        title="Who was here"
        description="A shift starts when somebody signs in and ends at the last thing they did — not when they close the tab."
      >
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nobody signed in at this location during {range.label.toLowerCase()}.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.userId} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {row.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {row.role.toLowerCase().replace(/_/g, ' ')}
                      {row.staffCode ? ` · ${row.staffCode}` : ''}
                    </span>
                    {row.onShiftNow ? (
                      <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                        On shift
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm tabular-nums">
                    <strong>{hhmm(row.totalMinutes)}</strong>
                    <span className="ml-2 text-xs text-muted-foreground">
                      over {row.days} day{row.days === 1 ? '' : 's'}
                    </span>
                  </p>
                </div>

                <ul className="mt-2 space-y-1">
                  {row.shifts.map((shift) => (
                    <li
                      key={shift.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                    >
                      <LocalDateTime value={shift.startedAt} />
                      <span>→</span>
                      {shift.endedAt ? (
                        <LocalDateTime value={shift.endedAt} />
                      ) : (
                        <span>still working</span>
                      )}
                      <span className="tabular-nums">{hhmm(shift.minutes)}</span>
                      {shift.idleOnly ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          signed in, no activity
                        </span>
                      ) : null}
                      {shift.closedBy === 'AUTO_CAP' ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          ran over — check this
                        </span>
                      ) : null}
                      {shift.corrected ? (
                        <span title={shift.adjustReason ?? undefined}>
                          corrected by {shift.adjustedByName ?? 'a manager'}
                        </span>
                      ) : null}
                      {canCorrect ? (
                        <ShiftCorrection
                          shiftId={shift.id}
                          startedAt={shift.startedAt}
                          endedAt={shift.endedAt}
                          personName={row.name}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          A shift that runs past midnight stays on the day it started, so an
          evening that ends at 01:30 is counted once, under the evening.
          Shared screens — a kitchen display everybody uses — are not counted:
          one account is shared by everyone who touches it, so it cannot say who
          was there.
        </p>
      </SectionCard>
    </>
  )
}

async function Performance({
  restaurantId,
  branchId,
  range,
  userId,
  currency,
  locale,
  money,
}: {
  restaurantId: string
  branchId: string
  range: ReturnType<typeof resolveRange>
  userId?: string
  currency: string
  locale: string
  money: (m: number) => string
}) {
  const report = await getBranchStaffPerformance({ restaurantId, branchIds: [branchId], range })
  const rows = userId ? report.rows.filter((r) => r.userId === userId) : report.rows

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="Orders here" value={report.total.orders} hint={range.label} />
        <StatCard label="Taken here" value={money(report.total.revenue)} />
        <StatCard
          label="Not attributed"
          value={money(report.unattributed.revenue)}
          hint={`${report.unattributed.orders} order(s) with no staff member`}
        />
      </div>

      <ReportTable
        title="What each person did here"
        description="Served is whose table it was. Rung is who keyed it in — a cashier ringing up a waiter's table is the normal case, so these are two different numbers."
        filename={`staff-${branchId}-${range.preset}`}
        currency={currency as never}
        locale={locale}
        empty="Nobody rang up or served anything here in this period."
        columns={[
          { key: 'name', label: 'Person' },
          { key: 'role', label: 'Role' },
          { key: 'ordersServed', label: 'Served', align: 'right' },
          { key: 'servedRevenue', label: 'Served value', align: 'right', format: 'money' },
          { key: 'ordersRung', label: 'Rung', align: 'right' },
          { key: 'paymentsTaken', label: 'Payments', align: 'right' },
          { key: 'paymentTotal', label: 'Collected', align: 'right', format: 'money' },
        ]}
        rows={rows as unknown as Array<Record<string, unknown>>}
      />

      <div className="mt-4 space-y-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
        <p>
          <strong className="text-foreground">Counter sales count as rung, not served.</strong>{' '}
          Somebody has to own a walk-in, so the till operator is recorded as its
          server — but they were not waiting a table, and a busy counter would
          otherwise top a list of the best waiters.
        </p>
        <p>
          <strong className="text-foreground">QR orders belong to nobody.</strong> A guest
          ordering from their own phone has no server and no cashier. That money
          is real, so it is shown above as <em>not attributed</em> rather than
          quietly left out — per person plus unattributed is the branch total.
        </p>
        <p>
          <strong className="text-foreground">Kitchen work is not measured here.</strong>{' '}
          Marking an item ready is not recorded against the person who did it, so
          a cook shows no sales — which means they did none, not that they did
          nothing. Do not read this table as a ranking across different jobs.
        </p>
      </div>
    </>
  )
}

async function Activity({
  restaurantId,
  branchId,
  range,
  userId,
}: {
  restaurantId: string
  branchId: string
  range: ReturnType<typeof resolveRange>
  userId?: string
}) {
  const entries = await getBranchStaffActivity({ restaurantId, branchId, range, userId })

  return (
    <SectionCard
      title="What happened here"
      description="Every recorded action at this location, newest first."
    >
      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing recorded in this period.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
              <span className="text-sm font-medium">
                {entry.user?.name ?? entry.actorName ?? 'Someone'}
              </span>
              <span className="text-sm text-muted-foreground">{describe(entry.action)}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                <LocalDateTime value={entry.createdAt.toISOString()} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

/** `inventory.count_approved` → `inventory · count approved`. */
function describe(action: string): string {
  const [group, rest] = action.includes('.') ? action.split('.') : ['', action]
  const words = rest.replace(/_/g, ' ')
  return group ? `${group} · ${words}` : words
}
