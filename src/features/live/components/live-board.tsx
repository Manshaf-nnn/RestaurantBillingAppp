'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ChefHat, CheckCircle2, ClipboardList, Clock, Star,
  Timer, Users, UtensilsCrossed,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { LiveBoardPolicy } from '../policy'
import {
  alertBoard, foldOrdersToTables, kpis, progressPct, waitBand, waitingMinutes,
  waitingPriority,
  type CustomerHistoryRow, type LiveTable, type OpenOrderRow, type ServiceCallRow,
  type Severity, type WaitBand,
} from '../derive'
import { Clock as LiveClock, Elapsed, NowProvider, useNow } from './now-provider'

/**
 * The floor, as it is right now.
 *
 * ── Everything about time is computed here, in the browser ──────────────────
 *
 * The server sends rows and a policy and nothing else. Bands, alerts and the
 * headline tiles are all derived from `useNow()`, so they change together, once
 * a second, against one clock.
 *
 * Deriving them on the server instead would go wrong in two visible ways: a
 * badge would say DELAYED for up to ten seconds after the digits beside it
 * ticked past the threshold, and the "delayed tables" tile would disagree with
 * the cards it is meant to be summarising, because the two were read at
 * different instants.
 */

const BAND_STYLE: Record<WaitBand, { ring: string; text: string; label: string }> = {
  NORMAL: { ring: 'border-emerald-500/50', text: 'text-emerald-600 dark:text-emerald-400', label: 'Normal' },
  WATCH: { ring: 'border-amber-400/60', text: 'text-amber-600 dark:text-amber-400', label: 'Watch' },
  ATTENTION: { ring: 'border-orange-500/60', text: 'text-orange-600 dark:text-orange-400', label: 'Attention' },
  DELAYED: { ring: 'border-red-500/60', text: 'text-red-600 dark:text-red-400', label: 'Delayed' },
  CRITICAL: { ring: 'border-red-600', text: 'text-red-600 dark:text-red-400', label: 'Critical' },
}

const SEVERITY_STYLE: Record<Severity, string> = {
  CRITICAL: 'border-destructive/50 bg-destructive/5',
  DELAYED: 'border-destructive/40 bg-destructive/5',
  ATTENTION: 'border-warning/40 bg-warning/5',
  PAYMENT: 'border-primary/30 bg-primary/5',
}

export interface LiveBoardProps {
  orders: OpenOrderRow[]
  history: CustomerHistoryRow[]
  calls: ServiceCallRow[]
  tablesTotal: number
  policy: LiveBoardPolicy
  currency: string
  locale: string
  timeZone: string
  branchName: string
  canSeeCustomers: boolean
}

export function LiveBoard(props: LiveBoardProps) {
  return (
    <NowProvider>
      <Board {...props} />
    </NowProvider>
  )
}

function Board({
  orders, history, calls, tablesTotal, policy, currency, locale, timeZone,
  branchName, canSeeCustomers,
}: LiveBoardProps) {
  const now = useNow()
  const [selected, setSelected] = React.useState<string | null>(null)

  const tables = React.useMemo(
    () =>
      foldOrdersToTables({
        orders,
        history: new Map(history.map((h) => [h.customerId, h])),
        calls,
        policy,
        timeZone,
      }),
    [orders, history, calls, policy, timeZone],
  )

  /*
   * `now ?? 0` rather than skipping the work: on the server pass every elapsed
   * figure is zero, which renders a complete and harmless board that the first
   * tick corrects a frame later. Rendering nothing instead would make the page
   * flash empty on every refresh.
   */
  const clock = now ?? Date.parse(orders[0]?.placedAt ?? '') ?? 0
  const tiles = kpis({ tables, tablesTotal, policy, now: clock })
  const priority = waitingPriority(tables, clock)
  const alerts = alertBoard(tables, policy, clock)

  const active = tables.find((t) => t.key === selected) ?? tables[0] ?? null
  const money = (m: number) => formatMoney(m, currency, locale)

  return (
    <div className="space-y-5">
      {/* ── the tiles ──────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={<Users />} label="Tables occupied" value={`${tiles.tablesOccupied}`}
          hint={`of ${tiles.tablesTotal} at ${branchName}`} />
        <Tile icon={<Clock />} label="Waiting" value={`${tiles.waitingTables}`}
          hint="tables with food still owing" />
        <Tile icon={<Timer />} label="Delayed" value={`${tiles.delayedTables}`}
          tone={tiles.delayedTables > 0 ? 'bad' : 'ok'}
          hint={`over ${policy.delayedMax} min`} />
        <Tile icon={<UtensilsCrossed />} label="Food served" value={`${tiles.servedPct}%`}
          hint={`${tiles.served} of ${tiles.ordered} items`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile icon={<ClipboardList />} label="Ordered" value={`${tiles.ordered}`} hint="items" small />
        <Tile icon={<ChefHat />} label="Preparing" value={`${tiles.preparing}`} hint="items" small />
        <Tile icon={<CheckCircle2 />} label="Ready" value={`${tiles.ready}`} hint="waiting to go out" small />
      </div>

      <div className="grid gap-5 xl:grid-cols-[20rem_1fr_20rem]">
        {/* ── longest waiting first ────────────────────────────────────── */}
        <SectionCard title="Waiting longest" description="Walk the floor in this order.">
          {priority.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing outstanding. Every table has its food.
            </p>
          ) : (
            <ol className="space-y-2">
              {priority.slice(0, 8).map((row, index) => {
                const band = waitBand(row.minutes, policy)
                return (
                  <li key={row.table.key}>
                    <button
                      type="button"
                      onClick={() => setSelected(row.table.key)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition hover:bg-muted',
                        BAND_STYLE[band].ring,
                        active?.key === row.table.key && 'bg-muted',
                      )}
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {row.table.tableId ? `Table ${row.table.tableNumber}` : row.table.orderNumber}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Served {row.table.served}/{row.table.ordered} · {row.pct}%
                        </span>
                      </span>
                      <span className={cn('shrink-0 text-right text-sm font-semibold', BAND_STYLE[band].text)}>
                        <Elapsed since={waitingFrom(row.table)} />
                        <span className="block text-[10px] font-medium uppercase tracking-wide">
                          {BAND_STYLE[band].label}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </SectionCard>

        {/* ── the floor ────────────────────────────────────────────────── */}
        <SectionCard
          title="Tables"
          description="Tap a table for who is sitting there and what they ordered."
        >
          {tables.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nothing open at {branchName}. Tables appear here as orders are placed.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {tables.map((table) => (
                <TableCard
                  key={table.key}
                  table={table}
                  policy={policy}
                  now={clock}
                  selected={active?.key === table.key}
                  onSelect={() => setSelected(table.key)}
                  canSeeCustomers={canSeeCustomers}
                />
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── who is sitting there ─────────────────────────────────────── */}
        <CustomerPanel
          table={active}
          canSeeCustomers={canSeeCustomers}
          money={money}
          timeZone={timeZone}
        />
      </div>

      {/* ── needs attention ──────────────────────────────────────────────── */}
      <SectionCard
        title="Needs attention"
        description="Worked out fresh every few seconds — an entry disappears the moment it stops being true."
        actions={
          alerts.length > 0 ? (
            <Badge variant="destructive">{alerts.length}</Badge>
          ) : (
            <Badge variant="success">All clear</Badge>
          )
        }
      >
        {alerts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing needs you right now.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {alerts.map((alert) => (
              <div
                key={alert.key}
                className={cn('rounded-xl border px-4 py-3', SEVERITY_STYLE[alert.severity])}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-semibold">
                    {alert.tableNumber.length <= 3 ? `Table ${alert.tableNumber}` : alert.tableNumber}
                  </p>
                  <Badge
                    variant={alert.severity === 'ATTENTION' ? 'warning' : alert.severity === 'PAYMENT' ? 'secondary' : 'destructive'}
                    size="sm"
                  >
                    {alert.severity.toLowerCase()}
                  </Badge>
                </div>
                <p className="mt-1 text-sm">{alert.headline.detail}</p>
                {alert.also.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {alert.also.slice(0, 3).map((reason) => (
                      <li key={reason.code} className="text-xs text-muted-foreground">
                        {reason.detail}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ── the legend, and the honest note about what the clock means ──── */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border bg-card px-4 py-3 text-xs">
        <span className="font-medium uppercase tracking-wide text-muted-foreground">Waiting time</span>
        {(['NORMAL', 'WATCH', 'ATTENTION', 'DELAYED', 'CRITICAL'] as WaitBand[]).map((band) => (
          <span key={band} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full border-2', BAND_STYLE[band].ring)} />
            <span className={BAND_STYLE[band].text}>{BAND_STYLE[band].label}</span>
          </span>
        ))}
        <span className="ml-auto text-muted-foreground">
          <LiveClock timeZone={timeZone} /> · counting from when the order reached the kitchen
        </span>
      </div>
    </div>
  )
}

/** Which instant a table's waiting badge counts from. Mirrors `waitingMinutes`. */
function waitingFrom(table: LiveTable): string {
  return table.served > 0 && table.latestOrderAt > table.seatedAt
    ? table.latestOrderAt
    : table.seatedAt
}

function Tile({
  icon, label, value, hint, tone, small,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'bad'
  small?: boolean
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-soft [&_svg]:size-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p
        className={cn(
          'mt-2 font-bold tabular-nums tracking-tight',
          small ? 'text-xl' : 'text-2xl',
          tone === 'bad' && 'text-destructive',
          tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function TableCard({
  table, policy, now, selected, onSelect, canSeeCustomers,
}: {
  table: LiveTable
  policy: LiveBoardPolicy
  now: number
  selected: boolean
  onSelect: () => void
  canSeeCustomers: boolean
}) {
  const minutes = waitingMinutes(table, now)
  const band = waitBand(minutes, policy)
  const pct = progressPct(table)
  const done = table.ordered > 0 && table.served >= table.ordered

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'rounded-xl border-2 bg-card p-3 text-left transition hover:shadow-elevated',
        done ? 'border-emerald-500/50' : BAND_STYLE[band].ring,
        selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-base font-bold">
          {table.tableId ? `T${table.tableNumber}` : table.orderNumber}
        </span>
        <span className={cn('text-sm font-semibold', done ? 'text-emerald-600 dark:text-emerald-400' : BAND_STYLE[band].text)}>
          {done ? 'served' : <Elapsed since={waitingFrom(table)} />}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground [&_svg]:size-3.5">
        <span className="flex items-center gap-1"><ClipboardList />{table.ordered}</span>
        <span className="flex items-center gap-1"><ChefHat />{table.preparing}</span>
        {table.ready > 0 ? (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <CheckCircle2 />{table.ready}
          </span>
        ) : null}
        <span className="flex items-center gap-1"><UtensilsCrossed />{table.served}</span>
        {table.guestCount ? (
          <span className="ml-auto flex items-center gap-1"><Users />{table.guestCount}</span>
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-sm font-semibold tabular-nums">{pct}%</span>
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full rounded-full transition-all', done ? 'bg-emerald-500' : 'bg-primary')}
            style={{ width: `${pct}%` }}
          />
        </span>
      </div>

      {canSeeCustomers ? (
        <p className="mt-2 truncate text-xs">
          {table.customer ? (
            <>
              <TierBadge table={table} />
              {table.customer.completedVisits > 0 ? (
                <span className="ml-1 text-muted-foreground">
                  {table.customer.completedVisits} visit{table.customer.completedVisits === 1 ? '' : 's'}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">Guest — not identified</span>
          )}
        </p>
      ) : null}
    </button>
  )
}

function TierBadge({ table }: { table: LiveTable }) {
  const customer = table.customer
  if (!customer) return null

  const tier =
    customer.tier === 'VIP' ? { label: 'VIP', className: 'text-violet-600 dark:text-violet-400' }
      : customer.tier === 'REGULAR' ? { label: 'Regular', className: 'text-emerald-600 dark:text-emerald-400' }
        : customer.tier === 'RETURNING' ? { label: 'Returning', className: 'text-sky-600 dark:text-sky-400' }
          : { label: 'First visit', className: 'text-amber-600 dark:text-amber-400' }

  return (
    <>
      <span className={cn('font-medium', tier.className)}>
        {customer.tier === 'FIRST_VISIT' ? <Star className="mr-0.5 inline size-3" /> : null}
        {tier.label}
      </span>
      {/*
        A second axis, not a fifth tier: a regular who has been away four months
        is both, and a manager wants to know both.
      */}
      {customer.gap === 'LONG_TIME_RETURN' ? (
        <span className="ml-1 rounded bg-violet-500/15 px-1 py-0.5 font-medium text-violet-700 dark:text-violet-300">
          back after {customer.returnedAfterDays}d
        </span>
      ) : customer.gap === 'WELCOME_BACK' ? (
        <span className="ml-1 text-muted-foreground">welcome back</span>
      ) : null}
    </>
  )
}

function CustomerPanel({
  table, canSeeCustomers, money, timeZone,
}: {
  table: LiveTable | null
  canSeeCustomers: boolean
  money: (m: number) => string
  timeZone: string
}) {
  if (!table) {
    return (
      <SectionCard title="Table details" description="Pick a table.">
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nothing selected.
        </p>
      </SectionCard>
    )
  }

  const pct = progressPct(table)
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' })
      .format(new Date(iso))

  return (
    <SectionCard
      title={table.tableId ? `Table ${table.tableNumber}` : table.orderNumber}
      description={table.area ?? undefined}
      actions={
        <Link
          href={`/dashboard/orders/${table.primaryOrderId}`}
          className="text-sm text-primary hover:underline"
        >
          Order details →
        </Link>
      }
    >
      {canSeeCustomers ? (
        <div className="mb-4">
          <p className="text-lg font-semibold">
            {table.customer?.name ?? table.walkInName}
          </p>
          {table.customer ? (
            <>
              <p className="mt-1 text-sm"><TierBadge table={table} /></p>
              <dl className="mt-3 space-y-1.5 text-sm">
                <Row label="Visits before this" value={`${table.customer.completedVisits}`} />
                <Row
                  label="Last visit"
                  value={table.customer.previousVisitAt ? day(table.customer.previousVisitAt) : '—'}
                />
                <Row
                  label="Came back after"
                  value={
                    table.customer.returnedAfterDays !== null
                      ? `${table.customer.returnedAfterDays} days`
                      : '—'
                  }
                />
                {table.customer.lifetimeSpend > 0 ? (
                  <Row label="Spent with you" value={money(table.customer.lifetimeSpend)} />
                ) : null}
              </dl>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              No phone number was taken, so there is no history to show. This is
              not the same person as other walk-ins.
            </p>
          )}
        </div>
      ) : null}

      <dl className="space-y-1.5 border-t border-border pt-3 text-sm">
        <Row label="At the table" value={<Elapsed since={table.seatedAt} />} />
        {table.guestCount ? <Row label="Guests" value={`${table.guestCount}`} /> : null}
        <Row label="Ordered" value={`${table.ordered} items`} />
        <Row label="Preparing" value={`${table.preparing}`} />
        {table.ready > 0 ? <Row label="Ready to go out" value={`${table.ready}`} /> : null}
        <Row label="Served" value={`${table.served}`} />
        {table.cancelled > 0 ? <Row label="Cancelled" value={`${table.cancelled}`} /> : null}
        <Row label="Progress" value={`${pct}%`} />
        {table.outstanding > 0 ? <Row label="Still to pay" value={money(table.outstanding)} /> : null}
        {table.orderIds.length > 1 ? (
          <Row label="Rounds" value={`${table.orderIds.length}`} />
        ) : null}
      </dl>

      {table.serviceCalls.length > 0 ? (
        <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs [&_svg]:size-3.5">
          <AlertTriangle />
          Called for service <Elapsed since={table.serviceCalls[0].createdAt} /> ago
        </p>
      ) : null}
    </SectionCard>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
