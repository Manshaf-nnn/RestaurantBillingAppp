import type { LiveBoardPolicy } from './policy'

/**
 * Everything the live board works out, as pure functions.
 *
 * ── Why none of this touches the database or the clock ──────────────────────
 *
 * `now` is a parameter everywhere. That is what makes a board about elapsed
 * time testable at all: a test can assert that a table 32 minutes into service
 * reads CRITICAL without waiting 32 minutes or stubbing a global.
 *
 * It is also what lets the browser own the ticking. The server sends rows and
 * a policy; the client re-derives bands, alerts and the headline tiles once a
 * second from its own clock. If the server decided the band instead, a badge
 * would freeze for ten seconds while the digits beside it counted up, and the
 * "delayed tables" tile would disagree with the cards it is summarising.
 */

// ── the shapes the query layer produces ──────────────────────────────────────

/** One open order, with its item quantities already rolled up. */
export interface OpenOrderRow {
  orderId: string
  orderNumber: string
  status: string
  paymentStatus: string
  tableId: string | null
  tableNumber: string | null
  tableLabel: string | null
  tableArea: string | null
  tableCapacity: number | null
  tableStatus: string | null
  guestCount: number | null
  customerId: string | null
  customerName: string
  customerPhone: string
  /** ISO strings — a Date cannot cross into a client component. */
  placedAt: string
  acceptedAt: string | null
  preparingAt: string | null
  readyAt: string | null
  servedAt: string | null
  grandTotal: number
  tipAmount: number
  paidTotal: number
  ordered: number
  queued: number
  preparing: number
  ready: number
  served: number
  cancelled: number
}

/** What the books know about a guest who is sitting down right now. */
export interface CustomerHistoryRow {
  customerId: string
  name: string
  phone: string
  completedVisits: number
  lifetimeSpend: number
  /** Their previous COMPLETED visit. Null on a first visit. */
  previousVisitAt: string | null
}

export interface ServiceCallRow {
  id: string
  tableId: string
  tableNumber: string
  type: string
  createdAt: string
}

/**
 * A table on the floor plan — the room, not the service.
 *
 * Deliberately thin, and deliberately NOT a `LiveTable`. Merging the two was
 * the obvious idea and it is wrong in a way that only shows up an hour later:
 * `alertsFor` reads `seatedAt` unconditionally for its long-sitting rule, so an
 * empty table carrying an invented `seatedAt` starts announcing "at the table
 * 1h 30m" about a table nobody is at — and `kpis` counts anything with a
 * `tableId` as occupied, so the headline figure would count the empties too.
 *
 * Keeping them apart means none of the derived functions need to know this type
 * exists. That is the whole argument for two arrays.
 */
export interface FloorTableRow {
  id: string
  number: string
  label: string | null
  area: string | null
  capacity: number
  /** `TableStatus` as text. Only ever used as a sub-label — see `emptyTableLabel`. */
  status: string
  sortOrder: number
}

/**
 * The tables nobody is sitting at.
 *
 * Occupancy comes from the open orders, never from `RestaurantTable.status` —
 * that column lands in CLEANING after every bill and only a busser clears it,
 * so trusting it would show a floor emptier than it is from lunchtime onwards.
 *
 * Filtered on `tableId` and not on `key`: a takeaway's key is `order:<id>`,
 * which belongs to no table, and matching on it would quietly stop removing
 * anything.
 */
export function emptyTables(floor: FloorTableRow[], occupied: LiveTable[]): FloorTableRow[] {
  const seated = new Set(
    occupied.map((table) => table.tableId).filter((id): id is string => id !== null),
  )
  return floor.filter((row) => !seated.has(row.id))
}

/**
 * What to say on a table with nobody at it.
 *
 * A whitelist rather than the shared `TABLE_STATUS_META`, because the status
 * column is stale by design: a table with no open order can still say OCCUPIED
 * or WAITING_BILL from a party that left. Printing that label would have the
 * card contradict the board that just decided it was free, so anything not on
 * this list reads as available.
 */
export function emptyTableLabel(status: string): string {
  if (status === 'CLEANING') return 'Needs clearing'
  if (status === 'RESERVED') return 'Reserved'
  if (status === 'OUT_OF_SERVICE') return 'Out of service'
  return 'Available'
}

/**
 * Floor order: the layout, not the urgency.
 *
 * `number` is a string, so a plain sort gives 1, 10, 11, 2, 3 — fine on the
 * handful of active tables other screens list, obvious the moment thirty are on
 * screen at once. Numeric where both sides are numbers, natural otherwise so
 * T2 still precedes T10.
 */
export function compareFloor(a: FloorTableRow, b: FloorTableRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' })
}

// ── customer recognition ─────────────────────────────────────────────────────

export type CustomerTier = 'FIRST_VISIT' | 'RETURNING' | 'REGULAR' | 'VIP'
export type ReturnGap = 'NONE' | 'WELCOME_BACK' | 'LONG_TIME_RETURN'

export interface Recognition {
  customerId: string
  name: string
  tier: CustomerTier
  /**
   * A separate axis from the tier, not a fifth tier. A regular who has been
   * away four months is both REGULAR and a LONG_TIME_RETURN, and flattening
   * those into one badge loses whichever half the manager needed.
   */
  gap: ReturnGap
  completedVisits: number
  lifetimeSpend: number
  previousVisitAt: string | null
  returnedAfterDays: number | null
}

/** Whole days between two instants, in the restaurant's own calendar. */
export function daysBetween(fromIso: string, toIso: string, timeZone: string): number {
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso))

  // Compared as calendar days, not as elapsed hours: a guest who came at 11pm
  // and returns at 1am two nights later was away two days, not one and a bit.
  const a = Date.parse(`${day(fromIso)}T00:00:00.000Z`)
  const b = Date.parse(`${day(toIso)}T00:00:00.000Z`)
  return Math.round((b - a) / 86_400_000)
}

export function recognise(params: {
  history: CustomerHistoryRow
  /** When THIS sitting began — not `now`, which drifts through the meal. */
  visitStartedAt: string
  policy: LiveBoardPolicy
  timeZone: string
}): Recognition {
  const { history, policy } = params

  const tier: CustomerTier =
    history.completedVisits === 0
      ? 'FIRST_VISIT'
      : history.completedVisits >= policy.vipAfterVisits ||
          (policy.vipAfterSpend > 0 && history.lifetimeSpend >= policy.vipAfterSpend)
        ? 'VIP'
        : history.completedVisits >= policy.regularAfterVisits
          ? 'REGULAR'
          : 'RETURNING'

  const returnedAfterDays = history.previousVisitAt
    ? daysBetween(history.previousVisitAt, params.visitStartedAt, params.timeZone)
    : null

  const gap: ReturnGap =
    returnedAfterDays === null
      ? 'NONE'
      : returnedAfterDays >= policy.longTimeReturnDays
        ? 'LONG_TIME_RETURN'
        : returnedAfterDays >= policy.welcomeBackDays
          ? 'WELCOME_BACK'
          : 'NONE'

  return {
    customerId: history.customerId,
    name: history.name,
    tier,
    gap,
    completedVisits: history.completedVisits,
    lifetimeSpend: history.lifetimeSpend,
    previousVisitAt: history.previousVisitAt,
    returnedAfterDays,
  }
}

// ── folding orders into tables ───────────────────────────────────────────────

export interface LiveTable {
  key: string
  tableId: string | null
  tableNumber: string
  tableLabel: string | null
  area: string | null
  capacity: number | null
  guestCount: number | null
  /** Every open order on this table, newest last. */
  orderIds: string[]
  /** The one to open when somebody asks for details — the newest. */
  primaryOrderId: string
  orderNumber: string
  /** The oldest open order: when this party started being served. */
  seatedAt: string
  /** The newest, so a second round can be shown as such. */
  latestOrderAt: string
  acceptedAt: string | null
  preparingAt: string | null
  readyAt: string | null
  servedAt: string | null
  ordered: number
  queued: number
  preparing: number
  ready: number
  served: number
  cancelled: number
  outstanding: number
  paymentStatus: string
  customer: Recognition | null
  /** The name typed at the till, for a guest with no record of their own. */
  walkInName: string
  serviceCalls: ServiceCallRow[]
}

/**
 * One card per table, not per order.
 *
 * A table can carry more than one open order — a split bill, or a second round
 * ordered an hour later — and every count on the card is the party's, not one
 * ticket's. Folding first is also what stops the same table appearing twice in
 * the alert list.
 *
 * An order with no table (a takeaway, a delivery) keeps its own card keyed by
 * order id, because it is a real thing waiting on the kitchen even though
 * nobody is sitting at it.
 */
export function foldOrdersToTables(params: {
  orders: OpenOrderRow[]
  history: Map<string, CustomerHistoryRow>
  calls: ServiceCallRow[]
  policy: LiveBoardPolicy
  timeZone: string
}): LiveTable[] {
  const byKey = new Map<string, LiveTable>()
  const callsByTable = new Map<string, ServiceCallRow[]>()
  for (const call of params.calls) {
    const list = callsByTable.get(call.tableId) ?? []
    list.push(call)
    callsByTable.set(call.tableId, list)
  }

  // Oldest first, so `seatedAt` falls out of the first row seen and the later
  // rounds simply extend it.
  const ordered = [...params.orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt))

  for (const row of ordered) {
    const key = row.tableId ?? `order:${row.orderId}`
    const existing = byKey.get(key)

    if (!existing) {
      byKey.set(key, {
        key,
        tableId: row.tableId,
        tableNumber: row.tableNumber ?? row.orderNumber,
        tableLabel: row.tableLabel,
        area: row.tableArea,
        capacity: row.tableCapacity,
        guestCount: row.guestCount,
        orderIds: [row.orderId],
        primaryOrderId: row.orderId,
        orderNumber: row.orderNumber,
        seatedAt: row.placedAt,
        latestOrderAt: row.placedAt,
        acceptedAt: row.acceptedAt,
        preparingAt: row.preparingAt,
        readyAt: row.readyAt,
        servedAt: row.servedAt,
        ordered: row.ordered,
        queued: row.queued,
        preparing: row.preparing,
        ready: row.ready,
        served: row.served,
        cancelled: row.cancelled,
        outstanding: Math.max(0, row.grandTotal + row.tipAmount - row.paidTotal),
        paymentStatus: row.paymentStatus,
        customer: null,
        walkInName: row.customerName,
        serviceCalls: row.tableId ? (callsByTable.get(row.tableId) ?? []) : [],
      })
    } else {
      existing.orderIds.push(row.orderId)
      existing.primaryOrderId = row.orderId
      existing.orderNumber = row.orderNumber
      existing.latestOrderAt = row.placedAt
      existing.ordered += row.ordered
      existing.queued += row.queued
      existing.preparing += row.preparing
      existing.ready += row.ready
      existing.served += row.served
      existing.cancelled += row.cancelled
      existing.outstanding += Math.max(0, row.grandTotal + row.tipAmount - row.paidTotal)
      // A party is only fully paid when every one of its bills is.
      if (row.paymentStatus !== 'PAID') existing.paymentStatus = row.paymentStatus
      // The freshest kitchen milestone across the party's tickets.
      existing.acceptedAt = later(existing.acceptedAt, row.acceptedAt)
      existing.preparingAt = later(existing.preparingAt, row.preparingAt)
      existing.readyAt = later(existing.readyAt, row.readyAt)
      existing.servedAt = later(existing.servedAt, row.servedAt)
      // A guest count typed on any ticket is the party's.
      existing.guestCount = existing.guestCount ?? row.guestCount
    }
  }

  // Recognition last, so it is attached once per table rather than per order.
  for (const [, table] of byKey) {
    const row = ordered.find((o) => (o.tableId ?? `order:${o.orderId}`) === table.key)
    const record = row?.customerId ? params.history.get(row.customerId) : undefined
    if (record) {
      table.customer = recognise({
        history: record,
        visitStartedAt: table.seatedAt,
        policy: params.policy,
        timeZone: params.timeZone,
      })
    }
  }

  return [...byKey.values()]
}

const later = (a: string | null, b: string | null): string | null => {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

// ── progress and bands ───────────────────────────────────────────────────────

/**
 * How much of the food is out, as a percentage.
 *
 * The denominator excludes cancelled quantity, so voiding a dish nobody could
 * make lifts the percentage rather than capping it below 100 for ever. A table
 * whose entire order was voided is 0% of nothing, which reads as 0 rather than
 * as NaN.
 */
export function progressPct(table: Pick<LiveTable, 'ordered' | 'served'>): number {
  if (table.ordered <= 0) return 0
  return Math.round((table.served / table.ordered) * 100)
}

export type WaitBand = 'NORMAL' | 'WATCH' | 'ATTENTION' | 'DELAYED' | 'CRITICAL'

export function waitBand(minutes: number, policy: LiveBoardPolicy): WaitBand {
  if (minutes <= policy.normalMax) return 'NORMAL'
  if (minutes <= policy.watchMax) return 'WATCH'
  if (minutes <= policy.attentionMax) return 'ATTENTION'
  if (minutes <= policy.delayedMax) return 'DELAYED'
  return 'CRITICAL'
}

export const minutesSince = (iso: string, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))

/**
 * How long this party has been waiting.
 *
 * Zero once everything non-cancelled is out: the spec is explicit that the
 * waiting clock stops when the food is served, and a table lingering over
 * coffee is not a service failure. A later round starts it again, from that
 * round's own ticket rather than from when the party sat down.
 */
export function waitingMinutes(table: LiveTable, now: number): number {
  const outstanding = table.ordered - table.served
  if (outstanding <= 0) return 0
  // The oldest ticket that still has food owing. With one round that is the
  // party's own start; with a second round it is the round that is late.
  const from = table.served > 0 && table.latestOrderAt > table.seatedAt
    ? table.latestOrderAt
    : table.seatedAt
  return minutesSince(from, now)
}

// ── alerts ───────────────────────────────────────────────────────────────────

export type Severity = 'CRITICAL' | 'DELAYED' | 'ATTENTION' | 'PAYMENT'

export type AlertCode =
  | 'WAIT'
  | 'NO_SERVICE'
  | 'STUCK_PREPARING'
  | 'LOW_PROGRESS'
  | 'READY_NOT_SERVED'
  | 'SENSITIVE_WAITING'
  | 'LONG_SERVICE'
  | 'CALL_WAITER'
  | 'PAYMENT_PENDING'

export interface AlertReason {
  code: AlertCode
  severity: Severity
  detail: string
}

export interface TableAlert {
  key: string
  tableNumber: string
  severity: Severity
  waitingMinutes: number
  headline: AlertReason
  also: AlertReason[]
}

const RANK: Record<Severity, number> = { CRITICAL: 0, DELAYED: 1, ATTENTION: 2, PAYMENT: 3 }

/**
 * Which reason leads when two share a severity.
 *
 * Declared rather than left to whichever happened to be pushed first: relying
 * on insertion order is how a headline changes for no reason somebody can see.
 */
const PRIORITY: AlertCode[] = [
  'NO_SERVICE',
  'WAIT',
  'STUCK_PREPARING',
  'LOW_PROGRESS',
  'READY_NOT_SERVED',
  'SENSITIVE_WAITING',
  'CALL_WAITER',
  'LONG_SERVICE',
  'PAYMENT_PENDING',
]

/**
 * Everything wrong with one table, as at most one row.
 *
 * The de-duplication is the whole job. A table 32 minutes in, 40% served, with
 * food sitting under the lamp, matches four rules — and a manager wants one
 * line that says all of it, not four lines about one table. So reasons are
 * collected, the most severe leads, and the rest become a subline.
 *
 * Note there is exactly ONE waiting reason. The bands are the same measurement
 * read against different bars, so emitting one per band crossed is how a single
 * late table turns into three alerts.
 */
export function alertsFor(
  table: LiveTable,
  policy: LiveBoardPolicy,
  now: number,
): TableAlert | null {
  const reasons: AlertReason[] = []
  const waiting = waitingMinutes(table, now)
  const pct = progressPct(table)
  const band = waitBand(waiting, policy)
  const allServed = table.ordered > 0 && table.served >= table.ordered

  if (!allServed && (band === 'CRITICAL' || band === 'DELAYED' || band === 'ATTENTION')) {
    reasons.push({
      code: 'WAIT',
      severity: band === 'CRITICAL' ? 'CRITICAL' : band === 'DELAYED' ? 'DELAYED' : 'ATTENTION',
      detail: `Waiting ${waiting} min`,
    })
  }

  if (table.served === 0 && waiting >= policy.noFoodServedMin) {
    reasons.push({
      code: 'NO_SERVICE',
      severity: 'CRITICAL',
      detail: `Nothing served yet after ${waiting} min`,
    })
  } else if (!allServed && waiting >= policy.delayedMax && pct < policy.lowProgressPct) {
    // Only when something HAS been served — otherwise `NO_SERVICE` says it
    // better, and both together would be the same complaint twice.
    reasons.push({ code: 'LOW_PROGRESS', severity: 'DELAYED', detail: `Only ${pct}% served` })
  }

  if (table.preparing > 0) {
    const since = table.preparingAt ?? table.acceptedAt ?? table.seatedAt
    const mins = minutesSince(since, now)
    if (mins >= policy.stuckPreparingMin) {
      reasons.push({
        code: 'STUCK_PREPARING',
        severity: 'CRITICAL',
        detail: `${table.preparing} item(s) preparing for ${mins} min`,
      })
    }
  }

  if (table.ready > 0 && table.readyAt) {
    const mins = minutesSince(table.readyAt, now)
    if (mins >= policy.readyNotServedMin) {
      reasons.push({
        code: 'READY_NOT_SERVED',
        severity: 'ATTENTION',
        detail: `${table.ready} item(s) ready ${mins} min ago, not taken out`,
      })
    }
  }

  /*
   * One rule, one label. A VIP who is also a long-time return is one guest
   * worth going over to, not two alerts.
   */
  const sensitive = table.customer
    ? table.customer.gap === 'LONG_TIME_RETURN'
      ? 'Long-time return'
      : table.customer.tier === 'VIP'
        ? 'VIP'
        : table.customer.tier === 'FIRST_VISIT'
          ? 'First visit'
          : table.customer.gap === 'WELCOME_BACK'
            ? 'Back after a while'
            : null
    : null

  if (sensitive && !allServed && waiting >= policy.sensitiveWaitingMin) {
    reasons.push({
      code: 'SENSITIVE_WAITING',
      severity: 'ATTENTION',
      detail: `${sensitive} — waiting ${waiting} min`,
    })
  }

  for (const call of table.serviceCalls) {
    const mins = minutesSince(call.createdAt, now)
    if (mins >= policy.serviceRequestMin) {
      reasons.push({
        code: 'CALL_WAITER',
        severity: 'ATTENTION',
        detail: `Called for service ${mins} min ago`,
      })
      break
    }
  }

  const sittingFor = minutesSince(table.seatedAt, now)
  if (sittingFor >= policy.longServiceMin) {
    reasons.push({
      code: 'LONG_SERVICE',
      severity: 'ATTENTION',
      detail: `At the table ${Math.floor(sittingFor / 60)}h ${sittingFor % 60}m`,
    })
  }

  if (allServed && table.paymentStatus !== 'PAID' && table.servedAt) {
    const mins = minutesSince(table.servedAt, now)
    if (mins >= policy.paymentPendingMin) {
      reasons.push({
        code: 'PAYMENT_PENDING',
        severity: 'PAYMENT',
        detail: `All served ${mins} min ago, bill unpaid`,
      })
    }
  }

  if (reasons.length === 0) return null

  const sorted = [...reasons].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code),
  )

  return {
    key: table.key,
    tableNumber: table.tableNumber,
    severity: sorted[0].severity,
    waitingMinutes: waiting,
    headline: sorted[0],
    also: sorted.slice(1),
  }
}

/** Every table that needs somebody, worst first. */
export function alertBoard(
  tables: LiveTable[],
  policy: LiveBoardPolicy,
  now: number,
): TableAlert[] {
  return tables
    .map((table) => alertsFor(table, policy, now))
    .filter((alert): alert is TableAlert => alert !== null)
    .sort(
      (a, b) => RANK[a.severity] - RANK[b.severity] || b.waitingMinutes - a.waitingMinutes,
    )
}

// ── the headline tiles ───────────────────────────────────────────────────────

export interface LiveKpis {
  tablesOccupied: number
  tablesTotal: number
  waitingTables: number
  delayedTables: number
  ordered: number
  preparing: number
  ready: number
  served: number
  servedPct: number
}

/**
 * The tiles, derived from the same rows and the same clock as the cards.
 *
 * Computing these separately — a second aggregate, or a server-side count —
 * is how a tile ends up disagreeing with the cards it is summarising, because
 * the two would be read at different instants against different clocks.
 */
export function kpis(params: {
  tables: LiveTable[]
  tablesTotal: number
  policy: LiveBoardPolicy
  now: number
}): LiveKpis {
  const seated = params.tables.filter((t) => t.tableId !== null)
  let ordered = 0
  let preparing = 0
  let ready = 0
  let served = 0
  let waiting = 0
  let delayed = 0

  for (const table of params.tables) {
    ordered += table.ordered
    preparing += table.preparing
    ready += table.ready
    served += table.served

    const outstanding = table.ordered - table.served
    if (outstanding > 0) {
      waiting += 1
      const band = waitBand(waitingMinutes(table, params.now), params.policy)
      if (band === 'DELAYED' || band === 'CRITICAL') delayed += 1
    }
  }

  return {
    tablesOccupied: seated.length,
    tablesTotal: params.tablesTotal,
    waitingTables: waiting,
    delayedTables: delayed,
    ordered,
    preparing,
    ready,
    served,
    servedPct: ordered > 0 ? Math.round((served / ordered) * 100) : 0,
  }
}

/** Longest wait first — the order somebody should walk the floor in. */
export function waitingPriority(
  tables: LiveTable[],
  now: number,
): Array<{ table: LiveTable; minutes: number; pct: number }> {
  return tables
    .filter((table) => table.ordered - table.served > 0)
    .map((table) => ({
      table,
      minutes: waitingMinutes(table, now),
      pct: progressPct(table),
    }))
    .sort((a, b) => b.minutes - a.minutes)
}
