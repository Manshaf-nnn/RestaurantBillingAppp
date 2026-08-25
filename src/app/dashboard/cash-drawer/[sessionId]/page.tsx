import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LocalDateTime } from '@/components/local-time'
import { getDrawerSummary } from '@/features/cashdrawer/service'
import { MOVEMENT_TYPES } from '@/features/cashdrawer/movement-types'
import { listRequests } from '@/features/pettycash/service'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePageAnyPermission, assertRecordBranch } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Drawer session' }

/**
 * One shift's drawer, in full.
 *
 * ── Why this page had to exist ──────────────────────────────────────────────
 *
 * `getDrawerSummary` has always returned every movement with who made it and
 * why, and it was rendered in exactly one place: the live panel for your *own*
 * open drawer. The moment a session closed, its movement list became
 * unreachable through the UI — the report showed a variance and no way to find
 * out what it was made of.
 *
 * The audit trail at the bottom is the other half of that. The close action
 * records the whole reconciliation in `after`, and `/dashboard/audit-logs`
 * renders five columns and never `before`/`after`. The payload has been written
 * to the database and shown nowhere.
 */
export default async function DrawerSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const user = await requirePageAnyPermission(
    [PERMISSIONS.CASH_DRAWER_OPERATE, PERMISSIONS.CASH_DRAWER_MANAGE],
    '/dashboard/cash-drawer',
  )
  const { sessionId } = await params
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const summary = await getDrawerSummary(user.restaurantId, sessionId)
  /*
   * `getDrawerSummary` scopes by restaurant alone, which was fine while it only
   * ever loaded your own live session. Exposing it by id needs the branch check
   * as well, or a session id is all it takes to read another site's takings.
   */
  await assertRecordBranch(user, summary.session, 'Drawer session')

  const [names, petty, trail] = await Promise.all([
    prisma.cashDrawerSession.findUnique({
      where: { id: sessionId },
      select: {
        branch: { select: { name: true } },
        register: { select: { name: true } },
        openedBy: { select: { name: true } },
        closedBy: { select: { name: true } },
        reviewedBy: { select: { name: true } },
      },
    }),
    listRequests({ restaurantId: user.restaurantId, limit: 200 }).then((rows) =>
      rows.filter((row) => row.sessionId === sessionId),
    ),
    prisma.auditLog.findMany({
      where: { entity: 'CashDrawerSession', entityId: sessionId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, action: true, actorName: true, createdAt: true, after: true },
    }),
  ])

  const s = summary.session
  const uncounted = s.countedCash === null && s.closedAt !== null

  return (
    <>
      <PageHeader
        title={s.sessionNumber}
        description={[names?.branch?.name, names?.register?.name, names?.openedBy?.name]
          .filter(Boolean)
          .join(' · ')}
      />

      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/cash-drawer">
            <ArrowLeft className="mr-2 h-4 w-4" /> Cash drawer
          </Link>
        </Button>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge
          variant={
            s.status === 'OPEN' ? 'success' : s.status === 'PENDING_REVIEW' ? 'warning' : 'outline'
          }
        >
          {s.status === 'OPEN' ? 'Open' : s.status === 'PENDING_REVIEW' ? 'In review' : 'Closed'}
        </Badge>
        <span>
          Opened <LocalDateTime value={s.openedAt.toISOString()} /> by{' '}
          {names?.openedBy?.name ?? 'Unknown'}
        </span>
        {s.closedAt ? (
          <span>
            · Closed <LocalDateTime value={s.closedAt.toISOString()} /> by{' '}
            {names?.closedBy?.name ?? 'Unknown'}
            {s.closedOnBehalf ? ' (on their behalf)' : ''}
          </span>
        ) : null}
        {names?.reviewedBy?.name ? <span>· Signed off by {names.reviewedBy.name}</span> : null}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Opening float" value={money(summary.openingFloat)} />
        <StatCard label="Cash sales" value={money(summary.cashSales)} />
        <StatCard label="Cash in" value={money(summary.cashIn)} />
        <StatCard label="Cash out" value={money(summary.cashOut)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Card takings" value={money(summary.cardSales)} hint="never in the drawer" />
        <StatCard label="Other takings" value={money(summary.otherSales)} hint="QR, online, bank" />
        <StatCard
          label="Expected"
          value={money(s.expectedCash ?? summary.expectedCash)}
          hint={s.closedAt ? 'as recorded at close' : 'live'}
        />
        <StatCard
          label="Counted"
          value={s.countedCash === null ? '—' : money(s.countedCash)}
          hint={uncounted ? 'nobody counted it' : undefined}
        />
      </div>

      {s.closedAt ? (
        <div
          className={`mb-6 rounded-lg border p-3 text-sm ${
            uncounted
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
              : s.variance === 0
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
          }`}
        >
          {uncounted ? (
            <>
              <strong>The variance is unknown.</strong> This drawer was closed without a count, so
              there is no honest figure to report — recording zero would have claimed it balanced
              when nobody looked.
            </>
          ) : s.variance === 0 ? (
            <>
              <strong>Balanced exactly.</strong>
            </>
          ) : (
            <>
              <strong>
                {(s.variance ?? 0) > 0 ? 'Over' : 'Short'} by {money(Math.abs(s.variance ?? 0))}.
              </strong>{' '}
              The difference is recorded against {names?.openedBy?.name ?? 'the cashier'}, whose
              shift it was.
            </>
          )}
          {s.varianceReason ? (
            <p className="mt-1 italic">&ldquo;{s.varianceReason}&rdquo;</p>
          ) : null}
          {s.reviewNote ? (
            <p className="mt-1">
              Sign-off note: <span className="italic">&ldquo;{s.reviewNote}&rdquo;</span>
            </p>
          ) : null}
        </div>
      ) : null}

      <SectionCard
        title="The petty cash tin"
        description="Counted separately from the drawer all shift."
        className="mb-6"
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Opening" value={money(summary.openingPettyCash)} />
          <StatCard label="Topped up" value={money(summary.pettyCashToppedUp)} />
          <StatCard label="Spent" value={money(summary.pettyCashSpent)} />
          <StatCard label="Left" value={money(summary.pettyCashBalance)} />
        </div>
      </SectionCard>

      <SectionCard
        title="Every movement"
        description="Each note in or out that was not a sale, with who recorded it and why."
        className="mb-6"
      >
        {summary.movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing moved in or out of this drawer beyond sales.
          </p>
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">When</th>
                  <th className="pb-2 pr-3 font-medium">What</th>
                  <th className="pb-2 pr-3 font-medium">Why</th>
                  <th className="pb-2 pr-3 font-medium">By</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.movements.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      <LocalDateTime value={m.createdAt.toISOString()} />
                    </td>
                    <td className="py-2.5 pr-3">{MOVEMENT_TYPES[m.type].label}</td>
                    <td className="py-2.5 pr-3">
                      {m.reason}
                      {m.reference ? (
                        <span className="block text-xs text-muted-foreground">{m.reference}</span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{m.createdByName ?? '—'}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {m.signedAmount > 0 ? '+' : '−'}
                      {money(m.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {petty.length > 0 && (
        <SectionCard
          title="Petty cash paid against this shift"
          className="mb-6"
          description="Which tin each came out of — only a drawer-paid one changes the count above."
        >
          <ul className="divide-y divide-border">
            {petty.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-sm">
                <span>
                  {p.description}
                  <span className="block text-xs text-muted-foreground">
                    {p.category} · {p.paidFrom === 'PETTY_FUND' ? 'from the tin' : 'from the drawer'}
                    {p.paidBy?.name ? ` · paid by ${p.paidBy.name}` : ''}
                  </span>
                </span>
                <span className="tabular-nums">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title="What happened to this drawer"
        description="The audit trail, as recorded at the time. Nothing here can be edited."
      >
        {trail.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries.</p>
        ) : (
          <ul className="space-y-3">
            {trail.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                  <span className="text-muted-foreground">
                    {entry.actorName ?? 'Unknown'} · <LocalDateTime value={entry.createdAt.toISOString()} />
                  </span>
                </div>
                {entry.after ? (
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    {Object.entries(entry.after as Record<string, unknown>).map(([key, value]) => (
                      <div key={key} className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">{FIELD_LABELS[key] ?? key}</dt>
                        <dd className="tabular-nums">
                          {MONEY_FIELDS.has(key) && typeof value === 'number'
                            ? money(value)
                            : String(value ?? '—')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  )
}

/** Audit actions in the words somebody reading this would use. */
const ACTION_LABELS: Record<string, string> = {
  'cashDrawer.opened': 'Opened',
  'cashDrawer.closed': 'Closed',
  'cashDrawer.force_closed': 'Closed by a manager',
  'cashDrawer.reviewed': 'Signed off',
  'cashDrawer.handed_over': 'Handed over',
  'cashDrawer.handover_accepted': 'Taken on',
  'cashDrawer.handover_declined': 'Handover declined',
}

const FIELD_LABELS: Record<string, string> = {
  sessionNumber: 'Session',
  openingFloat: 'Opening float',
  openingPettyCash: 'Opening petty cash',
  cashSales: 'Cash sales',
  cashIn: 'Cash in',
  cashOut: 'Cash out',
  expectedCash: 'Expected',
  countedCash: 'Counted',
  variance: 'Variance',
  varianceReason: 'Reason',
  reviewNote: 'Sign-off note',
  openedById: 'Opened by',
  status: 'Status',
  reason: 'Reason',
}

/** Fields stored in minor units, so they print as money rather than integers. */
const MONEY_FIELDS = new Set([
  'openingFloat',
  'openingPettyCash',
  'cashSales',
  'cashIn',
  'cashOut',
  'expectedCash',
  'countedCash',
  'variance',
])
