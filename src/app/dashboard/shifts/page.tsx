import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { listStationBranches, selectedBranch } from '@/features/dashboard/selected-branch'
import { HandoverHistorySection } from '@/features/shifts/components/handover-history-section'
import { RotaBoard } from '@/features/shifts/components/rota-board'
import { HistoryFilters, ShiftHistoryTable } from '@/features/shifts/components/shift-panel'
import { TemplatesManager } from '@/features/shifts/components/templates-manager'
import { loadShiftPanel } from '@/features/shifts/panel-data'
import { listRotaStaff, listShiftAssignments, listShiftTemplates } from '@/features/shifts/queries'
import { dateKeyIn } from '@/features/shifts/service'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePageAnyPermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Shifts' }

const TABS = ['rota', 'templates', 'shifts', 'handovers'] as const
type Tab = (typeof TABS)[number]

const TAB_LABEL: Record<Tab, string> = {
  rota: 'Rota',
  templates: 'Templates',
  shifts: 'Shift history',
  handovers: 'Handover history',
}

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Monday of the week a date falls in. */
function weekStart(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  return addDays(dateKey, dow === 0 ? -6 : 1 - dow)
}

/**
 * Shift management for whoever runs the rota (shifthandover.md §1–2 and the
 * histories): templates, the week's rota, and the shift and handover
 * histories with filters and exports. A manager is confined to their own
 * site by the role itself; an owner picks a site with the switcher or sees
 * every one.
 */
export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePageAnyPermission(
    [PERMISSIONS.SHIFT_ASSIGN, PERMISSIONS.SHIFT_TEMPLATE_MANAGE],
    '/dashboard/shifts',
  )
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const restaurant = await requireRestaurant(user.restaurantId)
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  const requested = typeof params.tab === 'string' ? params.tab : 'rota'
  const tab: Tab = (TABS as readonly string[]).includes(requested) ? (requested as Tab) : 'rota'

  const today = dateKeyIn(new Date(), restaurant.timezone)
  const DATE = /^\d{4}-\d{2}-\d{2}$/
  const from = typeof params.from === 'string' && DATE.test(params.from) ? params.from : weekStart(today)
  const to = typeof params.to === 'string' && DATE.test(params.to) ? params.to : addDays(from, 6)

  const canAssign = can(user, PERMISSIONS.SHIFT_ASSIGN)
  const canManageTemplates = can(user, PERMISSIONS.SHIFT_TEMPLATE_MANAGE)

  const [branches, templates] = await Promise.all([
    listStationBranches(user),
    listShiftTemplates({ restaurantId: user.restaurantId, branchIds: selection.branchIds, includeInactive: true }),
  ])

  const header = (
    <>
      <PageHeader
        title="Shifts"
        description="The kinds of shift you run, who is on them, and how every shift and handover went."
        actions={
          tab === 'rota' ? (
            <ExportMenu type="shift-assignments" label="Export rota" />
          ) : tab === 'shifts' ? (
            <ExportMenu type="shift-sessions" label="Export shifts" />
          ) : tab === 'handovers' ? (
            <ExportMenu type="shift-handovers" label="Export handovers" />
          ) : null
        }
      />
      <nav className="mb-5 flex flex-wrap gap-1 rounded-xl border bg-muted/30 p-1" aria-label="Shift sections" data-testid="shift-tabs">
        {TABS.map((key) => (
          <Link
            key={key}
            href={`/dashboard/shifts?tab=${key}`}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              tab === key ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
            aria-current={tab === key ? 'page' : undefined}
          >
            {TAB_LABEL[key]}
          </Link>
        ))}
      </nav>
    </>
  )

  if (tab === 'templates') {
    return (
      <>
        {header}
        <TemplatesManager templates={templates} branches={branches} canManage={canManageTemplates} />
      </>
    )
  }

  if (tab === 'rota') {
    const [assignments, staff] = await Promise.all([
      listShiftAssignments({
        restaurantId: user.restaurantId,
        branchIds: selection.branchIds,
        from,
        to,
        templateId: typeof params.shift === 'string' ? params.shift : undefined,
        userId: typeof params.staff === 'string' ? params.staff : undefined,
      }),
      listRotaStaff({ restaurantId: user.restaurantId, branchIds: selection.branchIds }),
    ])
    return (
      <>
        {header}
        <RotaBoard
          assignments={assignments}
          templates={templates}
          staff={staff}
          branches={branches}
          from={from}
          to={to}
          today={today}
          canAssign={canAssign}
        />
      </>
    )
  }

  // The two histories share the Shift tab's loader, so the filters and the
  // rows are the ones staff see on their own tab — with the manager's reach.
  const panel = await loadShiftPanel({ user, timeZone: restaurant.timezone, selection, searchParams: params })

  return (
    <>
      {header}
      <div className="space-y-4">
        <div className="rounded-xl border bg-card p-4 shadow-soft">
          <HistoryFilters data={panel} />
        </div>
        {tab === 'shifts' ? (
          <div className="rounded-xl border bg-card p-4 shadow-soft">
            <ShiftHistoryTable rows={panel.shiftHistory} />
          </div>
        ) : (
          <HandoverHistorySection
            rows={panel.handovers}
            viewerId={user.id}
            canCancelOthers={panel.canSeeAll}
            currency={restaurant.currency}
            locale={locale}
          />
        )}
      </div>
    </>
  )
}
