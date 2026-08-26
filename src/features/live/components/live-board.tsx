'use client'

import * as React from 'react'
import {
  AlertTriangle, Armchair, BellRing, ChefHat, CheckCircle2, ClipboardList,
  Clock, Flame, HandPlatter, Receipt, Star, Timer, Users, UtensilsCrossed,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/primitives'
import { SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { LiveBoardPolicy } from '../policy'
import {
  alertBoard, compareFloor, emptyTableLabel, emptyTables, foldOrdersToTables,
  kpis, progressPct, waitBand, waitingMinutes, waitingPriority,
  type CustomerHistoryRow, type FloorTableRow, type LiveTable, type OpenOrderRow,
  type ServiceCallRow, type Severity, type WaitBand,
} from '../derive'
import { Clock as LiveClock, Elapsed, NowProvider, useNow } from './now-provider'
import { OrderDialog } from './order-dialog'

/**
 * The floor, as it is right now.
 *
 * ── Everything about time is computed here, in the browser ──────────────────
 *
 * The server sends rows and a policy and nothing else. Bands, alerts and the
 * headline tiles are all derived from `useNow()`, so they change together, once
 * a second, against one clock. Deriving them on the server would leave a badge
 * frozen for ten seconds while the digits beside it ticked past the threshold,
 * and the "delayed" tile would disagree with the cards it summarises.
 *
 * ── Two lists, on purpose ───────────────────────────────────────────────────
 *
 * `tables` is built from open orders; `floor` is the room. They are never
 * merged — see `emptyTables` in `derive.ts` for the alert that starts lying if
 * they are.
 */

/**
 * The waiting ladder, in theme tokens.
 *
 * Watch is BLUE, not amber. The obvious ramp — green, amber, orange, red — puts
 * `warning` (38°) next to `chart-1` (20°), which is also `--primary` exactly:
 * eighteen degrees apart at the same saturation, indistinguishable across a
 * warm-lit room, and ambiguous with the ring that means "selected". Blue is
 * maximally separable from both, and the two red steps then differ by fill and
 * weight rather than by a hue nobody can name — which is also what makes this
 * readable to the ~8% of men with red-green colour deficiency.
 *
 * `border-2` is load-bearing, not a style choice: `globals.css:363` matches the
 * literal class `border` and forces `border-color` with `!important` on any
 * `bg-card` element. Written as `border`, every band on this board would come
 * out the same 8% white.
 */
const BAND: Record<WaitBand, { card: string; text: string; dot: string; label: string }> = {
  NORMAL: { card: 'border-success/50', text: 'text-success', dot: 'bg-success', label: 'Normal' },
  WATCH: { card: 'border-chart-2/60', text: 'text-chart-2', dot: 'bg-chart-2', label: 'Watch' },
  ATTENTION: { card: 'border-warning/70', text: 'text-warning', dot: 'bg-warning', label: 'Attention' },
  DELAYED: { card: 'border-destructive/60', text: 'text-destructive', dot: 'bg-destructive', label: 'Delayed' },
  CRITICAL: {
    card: 'border-destructive bg-destructive/10',
    text: 'text-destructive font-bold',
    dot: 'bg-destructive',
    label: 'Critical',
  },
}

const BAND_BADGE: Record<WaitBand, 'success' | 'info' | 'warning' | 'destructive'> = {
  NORMAL: 'success', WATCH: 'info', ATTENTION: 'warning',
  DELAYED: 'destructive', CRITICAL: 'destructive',
}

/** Money pending is a different kind of problem from time, so a different hue. */
const SEVERITY: Record<Severity, { card: string; badge: 'destructive' | 'warning' | 'secondary' }> = {
  CRITICAL: { card: 'border-destructive/60 bg-destructive/10', badge: 'destructive' },
  DELAYED: { card: 'border-destructive/40 bg-destructive/5', badge: 'destructive' },
  ATTENTION: { card: 'border-warning/50 bg-warning/5', badge: 'warning' },
  PAYMENT: { card: 'border-chart-4/40 bg-chart-4/5', badge: 'secondary' },
}

export interface LiveBoardProps {
  orders: OpenOrderRow[]
  history: CustomerHistoryRow[]
  calls: ServiceCallRow[]
  floor: FloorTableRow[]
  avgCookMinutes: number
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
  orders, history, calls, floor, avgCookMinutes, policy, currency, locale,
  timeZone, branchName, canSeeCustomers,
}: LiveBoardProps) {
  const now = useNow()
  const [selected, setSelected] = React.useState<string | null>(null)
  /*
   * The dialog holds its OWN order id, deliberately not `active.primaryOrderId`.
   * A refresh can take the open order off the board — it completes, it leaves —
   * and `active` then falls back to `tables[0]`, which would silently swap a
   * different party's order in behind an unchanged modal.
   */
  const [openOrderId, setOpenOrderId] = React.useState<string | null>(null)
  const closeOrder = React.useCallback(() => setOpenOrderId(null), [])

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

  // Keyed on the data, never on the clock — this must not re-run 60×/minute.
  const empty = React.useMemo(
    () => emptyTables(floor, tables).sort(compareFloor),
    [floor, tables],
  )
  const seatedTables = React.useMemo(() => tables.filter((t) => t.tableId !== null), [tables])
  const offFloor = React.useMemo(() => tables.filter((t) => t.tableId === null), [tables])

  /*
   * Zero on the server pass, which renders a complete and harmless board that
   * the first tick corrects a frame later. Rendering nothing instead would make
   * the page flash empty on every refresh.
   */
  const clock = now ?? 0
  const tiles = kpis({ tables, tablesTotal: floor.length, policy, now: clock })
  const priority = waitingPriority(tables, clock)
  const alerts = alertBoard(tables, policy, clock)
  // The board's own orders, so this can never disagree with the cards.
  const activeOrders = orders.filter((o) => o.status !== 'SERVED').length

  const active = tables.find((t) => t.key === selected) ?? tables[0] ?? null
  const money = (m: number) => formatMoney(m, currency, locale)

  return (
    <div className="space-y-4">
      {/* ── the headline ────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard
          icon={<Users />} tone="primary" label="Occupied"
          value={`${tiles.tablesOccupied}`} hint={`of ${tiles.tablesTotal} tables`}
        />
        <StatCard
          icon={<Clock />} tone={tiles.waitingTables > 0 ? 'warning' : 'default'}
          label="Waiting" value={`${tiles.waitingTables}`} hint="tables owed food"
        />
        <StatCard
          icon={<Flame />} tone={tiles.delayedTables > 0 ? 'destructive' : 'success'}
          label="Delayed" value={`${tiles.delayedTables}`} hint={`over ${policy.delayedMax} min`}
        />
        <StatCard icon={<ClipboardList />} tone="default" label="Ordered" value={`${tiles.ordered}`} hint="items" />
        <StatCard icon={<ChefHat />} tone="warning" label="Preparing" value={`${tiles.preparing}`} hint="items" />
        <StatCard
          icon={<HandPlatter />} tone={tiles.ready > 0 ? 'warning' : 'default'}
          label="Ready" value={`${tiles.ready}`} hint="waiting to go out"
        />
        <StatCard
          icon={<UtensilsCrossed />} tone="success" label="Food out"
          value={`${tiles.servedPct}%`} hint={`${tiles.served} of ${tiles.ordered} items`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[19rem_1fr_20rem]">
        {/* ── longest waiting ──────────────────────────────────────────── */}
        <SectionCard title="Waiting longest" description="The order to walk the floor in.">
          {priority.length === 0 ? (
            <Nothing icon={<CheckCircle2 />} text="Every table has its food." />
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
                        'flex w-full items-center gap-2.5 rounded-lg border-2 px-2.5 py-2 text-left transition hover:bg-muted/60',
                        BAND[band].card,
                        active?.key === row.table.key && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                      )}
                    >
                      <span className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
                        BAND[band].dot,
                      )}>
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">
                          {label(row.table)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {row.table.served}/{row.table.ordered} out · {row.pct}%
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={cn('block text-sm font-bold', BAND[band].text)}>
                          <Elapsed since={waitingFrom(row.table)} />
                        </span>
                        <Badge variant={BAND_BADGE[band]} size="sm" className="mt-0.5">
                          {BAND[band].label}
                        </Badge>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </SectionCard>

        {/* ── the room ─────────────────────────────────────────────────── */}
        <SectionCard
          title="The floor"
          description="Tap a table for the guest and the order."
          actions={<Legend />}
        >
          {seatedTables.length === 0 && empty.length === 0 ? (
            <Nothing icon={<Armchair />} text={`No tables set up at ${branchName}.`} />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
              {seatedTables.map((table) => (
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
              {empty.map((row) => (
                <EmptyCard key={row.id} row={row} />
              ))}
            </div>
          )}

          {offFloor.length > 0 ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Takeaway &amp; delivery
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
                {offFloor.map((table) => (
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
            </div>
          ) : null}
        </SectionCard>

        {/* ── who is sitting there ─────────────────────────────────────── */}
        <CustomerPanel
          table={active}
          canSeeCustomers={canSeeCustomers}
          money={money}
          timeZone={timeZone}
          onOpenOrder={setOpenOrderId}
        />
      </div>

      {/* ── needs attention + kitchen ────────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-[1fr_18rem]">
        <SectionCard
          title="Needs attention"
          description="Worked out fresh each time — an entry goes when the problem does."
          actions={
            alerts.length > 0
              ? <Badge variant="destructive">{alerts.length}</Badge>
              : <Badge variant="success">All clear</Badge>
          }
        >
          {alerts.length === 0 ? (
            <Nothing icon={<CheckCircle2 />} text="Nothing needs you right now." />
          ) : (
            <div className="grid gap-2.5 md:grid-cols-2 2xl:grid-cols-3">
              {alerts.map((alert) => (
                <button
                  key={alert.key}
                  type="button"
                  onClick={() => setSelected(alert.key)}
                  className={cn(
                    'rounded-xl border-2 px-3 py-2.5 text-left transition hover:brightness-105',
                    SEVERITY[alert.severity].card,
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="flex items-center gap-1.5 font-bold [&_svg]:size-3.5">
                      <AlertTriangle />
                      {alert.tableNumber.length <= 4 ? `Table ${alert.tableNumber}` : alert.tableNumber}
                    </p>
                    <Badge variant={SEVERITY[alert.severity].badge} size="sm">
                      {alert.severity.toLowerCase()}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm font-medium">{alert.headline.detail}</p>
                  {alert.also.slice(0, 2).map((reason) => (
                    <p key={reason.code} className="text-xs text-muted-foreground">
                      {reason.detail}
                    </p>
                  ))}
                </button>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Kitchen" description="Right now.">
          <dl className="space-y-3">
            <Figure
              icon={<ClipboardList />}
              label="Active orders"
              value={`${activeOrders}`}
              hint="tickets, not items"
            />
            <Figure
              icon={<Timer />}
              label="Avg cook time"
              value={`${avgCookMinutes} min`}
              /*
               * Not "prep time", and not "today". The figure measures accept →
               * ready, so it excludes the queue before the kitchen picked the
               * ticket up — which is the part that fails in a rush — and its
               * window is the last 200 tickets, cut at the server's midnight
               * rather than the restaurant's.
               */
              hint="kitchen accept → ready, last 200"
            />
          </dl>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3">
            <LiveClock timeZone={timeZone} />
            <span>· updates by itself</span>
          </p>
        </SectionCard>
      </div>

      <OrderDialog orderId={openOrderId} onClose={closeOrder} />
    </div>
  )
}

/** Table 8, or an order number for anything with no table. */
function label(table: LiveTable): string {
  return table.tableId ? `Table ${table.tableNumber}` : table.orderNumber
}

/** Which instant a table's waiting badge counts from. Mirrors `waitingMinutes`. */
function waitingFrom(table: LiveTable): string {
  return table.served > 0 && table.latestOrderAt > table.seatedAt
    ? table.latestOrderAt
    : table.seatedAt
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      {(['NORMAL', 'WATCH', 'ATTENTION', 'DELAYED', 'CRITICAL'] as WaitBand[]).map((band) => (
        <span key={band} className="flex items-center gap-1">
          <span className={cn('size-2 rounded-full', BAND[band].dot)} />
          <span className="text-muted-foreground">{BAND[band].label}</span>
        </span>
      ))}
    </div>
  )
}

function Nothing({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <p className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground [&_svg]:size-6 [&_svg]:opacity-50">
      {icon}
      {text}
    </p>
  )
}

function Figure({
  icon, label: text, value, hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <dt className="text-xs text-muted-foreground">{text}</dt>
        <dd className="text-lg font-bold tabular-nums">{value}</dd>
        {hint ? <dd className="text-[11px] text-muted-foreground">{hint}</dd> : null}
      </span>
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
        /*
         * `border-2`, not `border` — see the note on BAND. A `bg-card` element
         * whose class list contains the literal token `border` has its
         * border-colour overridden with `!important` by `globals.css:363`, and
         * every band on this board would render identically.
         */
        'rounded-xl border-2 bg-card p-3 text-left shadow-soft transition hover:shadow-elevated',
        done ? 'border-success/60' : BAND[band].card,
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn(
          'rounded-md px-2 py-0.5 text-sm font-bold text-white',
          done ? 'bg-success' : BAND[band].dot,
        )}>
          {table.tableId ? `T${table.tableNumber}` : table.orderNumber}
        </span>
        <span className={cn('text-sm font-bold', done ? 'text-success' : BAND[band].text)}>
          {done ? 'all out' : <Elapsed since={waitingFrom(table)} />}
        </span>
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-1 text-center">
        <Count icon={<ClipboardList />} value={table.ordered} label="ordered" />
        <Count icon={<ChefHat />} value={table.preparing} label="preparing"
          tone={table.preparing > 0 ? 'text-warning' : undefined} />
        <Count icon={<UtensilsCrossed />} value={table.served} label="served"
          tone={table.served > 0 ? 'text-success' : undefined} />
      </div>

      {table.ready > 0 ? (
        <p className="mt-1.5 flex items-center justify-center gap-1 rounded-md bg-warning/15 py-0.5 text-[11px] font-semibold text-warning [&_svg]:size-3">
          <HandPlatter />
          {table.ready} ready to go out
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-sm font-bold tabular-nums">{pct}%</span>
        <Progress
          value={pct}
          className="h-2 flex-1"
          indicatorClassName={done ? 'bg-success' : BAND[band].dot}
        />
      </div>

      {canSeeCustomers ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-border pt-2">
          {table.customer ? (
            <TierBadges customer={table.customer} />
          ) : (
            <span className="text-[11px] text-muted-foreground">Guest — not identified</span>
          )}
          {table.guestCount ? (
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground [&_svg]:size-3">
              <Users />{table.guestCount}
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  )
}

function Count({
  icon, value, label: text, tone,
}: {
  icon: React.ReactNode
  value: number
  label: string
  tone?: string
}) {
  return (
    <span className="rounded-md bg-muted/50 py-1">
      <span className={cn(
        'flex items-center justify-center gap-1 text-sm font-bold tabular-nums [&_svg]:size-3.5',
        tone ?? 'text-foreground',
      )}>
        {icon}{value}
      </span>
      <span className="block text-[10px] text-muted-foreground">{text}</span>
    </span>
  )
}

/**
 * A table nobody is at.
 *
 * No `bg-card`: `globals.css:357` forces a glass gradient over any tint on that
 * class, and thirty backdrop-filtered layers recompositing once a second on a
 * floor tablet is a real cost for a card that is meant to recede.
 */
function EmptyCard({ row }: { row: FloorTableRow }) {
  const text = emptyTableLabel(row.status)
  const needsClearing = row.status === 'CLEANING'
  const outOfService = row.status === 'OUT_OF_SERVICE'

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-3 text-center',
        needsClearing ? 'border-warning/40 bg-warning/5' : 'border-border bg-muted/30',
        outOfService && 'opacity-60',
      )}
    >
      <span className="text-sm font-bold text-muted-foreground">T{row.number}</span>
      <Armchair className="size-5 text-muted-foreground opacity-60" />
      <span className={cn('text-[11px]', needsClearing ? 'text-warning' : 'text-muted-foreground')}>
        {text}
      </span>
      <span className="text-[10px] text-muted-foreground">seats {row.capacity}</span>
    </div>
  )
}

/**
 * The guest's standing, as chips.
 *
 * Chips rather than coloured words: the tier palette and the waiting-band
 * palette are the same four tokens, so a green border above a green word reads
 * as one signal instead of two facts.
 */
function TierBadges({ customer }: { customer: NonNullable<LiveTable['customer']> }) {
  const tier =
    customer.tier === 'VIP'
      ? { label: 'VIP', className: 'bg-chart-4/15 text-chart-4 border-transparent' }
      : customer.tier === 'REGULAR'
        ? { label: 'Regular', className: 'bg-success/10 text-success border-transparent' }
        : customer.tier === 'RETURNING'
          ? { label: `Returning · ${customer.completedVisits}`, className: 'bg-chart-2/10 text-chart-2 border-transparent' }
          : { label: 'First visit', className: 'bg-warning/15 text-warning border-transparent' }

  return (
    <>
      <Badge size="sm" className={tier.className}>
        {customer.tier === 'FIRST_VISIT' ? <Star /> : null}
        {tier.label}
      </Badge>
      {customer.gap === 'LONG_TIME_RETURN' ? (
        <Badge size="sm" className="border-transparent bg-chart-4/15 text-chart-4">
          back after {customer.returnedAfterDays}d
        </Badge>
      ) : customer.gap === 'WELCOME_BACK' ? (
        <Badge size="sm" variant="secondary">welcome back</Badge>
      ) : null}
    </>
  )
}

function CustomerPanel({
  table, canSeeCustomers, money, timeZone, onOpenOrder,
}: {
  table: LiveTable | null
  canSeeCustomers: boolean
  money: (m: number) => string
  timeZone: string
  onOpenOrder: (orderId: string) => void
}) {
  if (!table) {
    return (
      <SectionCard title="Table details" description="Pick a table.">
        <Nothing icon={<Armchair />} text="Nothing selected." />
      </SectionCard>
    )
  }

  const pct = progressPct(table)
  const day = (isoDate: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' })
      .format(new Date(isoDate))
  const name = table.customer?.name ?? table.walkInName
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

  return (
    <SectionCard title={label(table)} description={table.area ?? undefined}>
      {canSeeCustomers ? (
        <div className="mb-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground">
              {initials || '—'}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-bold">{name}</span>
              <span className="mt-0.5 flex flex-wrap gap-1">
                {table.customer ? (
                  <TierBadges customer={table.customer} />
                ) : (
                  <span className="text-xs text-muted-foreground">Not identified</span>
                )}
              </span>
            </span>
          </div>

          {table.customer ? (
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
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No phone number was taken, so there is no history to show. This is
              not the same person as other walk-ins.
            </p>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
        <Summary value={table.ordered} label="ordered" />
        <Summary value={table.preparing} label="preparing" tone="text-warning" />
        <Summary value={table.served} label="served" tone="text-success" />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-sm font-bold tabular-nums">{pct}%</span>
        <Progress value={pct} className="h-2 flex-1" />
        <span className="text-xs text-muted-foreground">{table.served}/{table.ordered} out</span>
      </div>

      <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
        <Row label="At the table" value={<Elapsed since={table.seatedAt} />} />
        {table.guestCount ? <Row label="Guests" value={`${table.guestCount}`} /> : null}
        {table.ready > 0 ? <Row label="Ready to go out" value={`${table.ready}`} /> : null}
        {table.cancelled > 0 ? <Row label="Cancelled" value={`${table.cancelled}`} /> : null}
        {table.outstanding > 0 ? <Row label="Still to pay" value={money(table.outstanding)} /> : null}
        {table.orderIds.length > 1 ? <Row label="Rounds" value={`${table.orderIds.length}`} /> : null}
      </dl>

      {table.serviceCalls.length > 0 ? (
        <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning [&_svg]:size-3.5">
          <BellRing />
          Called for service <Elapsed since={table.serviceCalls[0].createdAt} /> ago
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => onOpenOrder(table.primaryOrderId)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/5 py-2 text-sm font-semibold text-primary transition hover:bg-primary/10 [&_svg]:size-4"
      >
        <Receipt />
        {/*
          `primaryOrderId` is the NEWEST ticket. With a split bill or a second
          round there is more than one, and saying "the order" would hide the
          others behind a button that claims to show everything.
        */}
        {table.orderIds.length > 1 ? 'View newest order' : 'View order details'}
      </button>
    </SectionCard>
  )
}

function Summary({ value, label: text, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 py-2">
      <p className={cn('text-xl font-bold tabular-nums', tone)}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{text}</p>
    </div>
  )
}

function Row({ label: text, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{text}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
