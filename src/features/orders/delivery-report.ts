import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * The Delivery Desk report: how many deliveries went out, what they were
 * worth, how long they took, what was collected at the door, and where they
 * went.
 *
 * ── What counts ─────────────────────────────────────────────────────────────
 *
 * DELIVERY orders PLACED in the period. A delivery is *delivered* once it is
 * SERVED or COMPLETED — the PIN handover writes SERVED, and a paid one moves on
 * to COMPLETED — and it carries `servedAt` and `servedById`, the door time and
 * the person. CANCELLED ones are counted apart. Sales are the grand totals of
 * delivered orders only: a cancelled delivery was never money. Cash collected
 * is the PAID `COD` payments on those orders — the money taken at the door.
 *
 * Times are whole minutes between stamps the order already keeps: placed →
 * door for the customer's wait, ready → door for the ride itself. An order
 * missing a stamp is left out of that average rather than counted as zero.
 */

export interface DeliveryReportData {
  delivered: number
  deliveredChange: number | null
  sales: number
  averageOrder: number
  /** Minutes from placing to the door, averaged over delivered orders with both stamps. */
  averageMinutes: number | null
  /** Minutes from ready to the door. */
  averageRideMinutes: number | null
  cashCollected: number
  cashCount: number
  cancelled: number
  outNow: number
  trend: Array<{ date: string; delivered: number; sales: number }>
  byPlace: Array<{ place: string; delivered: number; sales: number; share: number; averageMinutes: number | null }>
  byRider: Array<{
    name: string
    delivered: number
    cash: number
    /** Per-delivery pay earned in the period — the snapshots, summed. */
    earned: number
    averageRideMinutes: number | null
  }>
  /** Everything riders earned in the period. */
  riderPay: number
  recent: Array<{
    id: string
    orderNumber: string
    place: string | null
    customerName: string
    grandTotal: number
    deliveredAt: string
    minutes: number | null
    paidBy: string
  }>
}

const MINUTE = 60_000

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function daysBetween(from: Date, to: Date, timeZone: string): string[] {
  const days: string[] = []
  const seen = new Set<string>()
  for (let t = from.getTime(); t <= to.getTime(); t += 6 * 3_600_000) {
    const key = dayKey(new Date(t), timeZone)
    if (!seen.has(key)) {
      seen.add(key)
      days.push(key)
    }
  }
  const last = dayKey(to, timeZone)
  if (!seen.has(last)) days.push(last)
  return days
}

const minutesBetween = (a: Date | null, b: Date | null) =>
  a && b && b.getTime() >= a.getTime() ? Math.round((b.getTime() - a.getTime()) / MINUTE) : null

const mean = (values: Array<number | null>): number | null => {
  const real = values.filter((v): v is number => v !== null)
  return real.length ? Math.round(real.reduce((s, v) => s + v, 0) / real.length) : null
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash', CARD: 'Card', QR: 'QR', ONLINE: 'Online', WALLET: 'Wallet', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other', COD: 'Cash at the door', CHEQUE: 'Cheque',
}

export async function getDeliveryReport(params: {
  restaurantId: string
  branchIds: string[] | null
  from: Date
  to: Date
  previous: { from: Date; to: Date }
  timeZone: string
}): Promise<DeliveryReportData> {
  const { restaurantId, from, to, timeZone } = params
  const branch = params.branchIds ? { branchId: { in: params.branchIds } } : {}
  const DELIVERED = ['SERVED', 'COMPLETED'] as const

  const [orders, previousDelivered, outNow] = await Promise.all([
    prisma.order.findMany({
      where: { restaurantId, type: 'DELIVERY', ...branch, placedAt: { gte: from, lte: to } },
      orderBy: { servedAt: 'desc' },
      select: {
        id: true, orderNumber: true, status: true, customerName: true, grandTotal: true,
        placedAt: true, readyAt: true, servedAt: true, deliveryLocationName: true, deliveryPay: true,
        servedBy: { select: { name: true } },
        payments: { where: { status: { in: ['PAID', 'REFUNDED'] } }, select: { method: true, amount: true } },
      },
    }),
    prisma.order.count({
      where: { restaurantId, type: 'DELIVERY', ...branch, placedAt: { gte: params.previous.from, lte: params.previous.to }, status: { in: [...DELIVERED] } },
    }),
    // Right now, whatever the period: packed and waiting at the door or on the road.
    prisma.order.count({ where: { restaurantId, type: 'DELIVERY', ...branch, status: 'READY' } }),
  ])

  const delivered = orders.filter((o) => (DELIVERED as readonly string[]).includes(o.status))
  const cancelled = orders.filter((o) => o.status === 'CANCELLED').length
  const sales = delivered.reduce((s, o) => s + o.grandTotal, 0)
  const codOf = (o: (typeof orders)[number]) => o.payments.filter((p) => p.method === 'COD').reduce((s, p) => s + p.amount, 0)
  const cashCollected = delivered.reduce((s, o) => s + codOf(o), 0)
  const cashCount = delivered.filter((o) => codOf(o) > 0).length

  const perDay = new Map<string, { delivered: number; sales: number }>()
  for (const day of daysBetween(from, to, timeZone)) perDay.set(day, { delivered: 0, sales: 0 })
  const perPlace = new Map<string, { delivered: number; sales: number; minutes: Array<number | null> }>()
  const perRider = new Map<string, { delivered: number; cash: number; earned: number; ride: Array<number | null> }>()

  for (const o of delivered) {
    const key = dayKey(o.servedAt ?? o.placedAt, timeZone)
    const day = perDay.get(key) ?? { delivered: 0, sales: 0 }
    day.delivered += 1
    day.sales += o.grandTotal
    perDay.set(key, day)

    const place = o.deliveryLocationName ?? 'No place given'
    const p = perPlace.get(place) ?? { delivered: 0, sales: 0, minutes: [] }
    p.delivered += 1
    p.sales += o.grandTotal
    p.minutes.push(minutesBetween(o.placedAt, o.servedAt))
    perPlace.set(place, p)

    const rider = o.servedBy?.name ?? 'Not recorded'
    const r = perRider.get(rider) ?? { delivered: 0, cash: 0, earned: 0, ride: [] }
    r.delivered += 1
    r.cash += codOf(o)
    r.earned += o.deliveryPay ?? 0
    r.ride.push(minutesBetween(o.readyAt, o.servedAt))
    perRider.set(rider, r)
  }

  return {
    delivered: delivered.length,
    deliveredChange: previousDelivered > 0 ? (delivered.length - previousDelivered) / previousDelivered : null,
    sales,
    averageOrder: delivered.length ? Math.round(sales / delivered.length) : 0,
    averageMinutes: mean(delivered.map((o) => minutesBetween(o.placedAt, o.servedAt))),
    averageRideMinutes: mean(delivered.map((o) => minutesBetween(o.readyAt, o.servedAt))),
    cashCollected,
    cashCount,
    cancelled,
    outNow,
    trend: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    byPlace: [...perPlace.entries()]
      .map(([place, v]) => ({ place, delivered: v.delivered, sales: v.sales, share: delivered.length ? v.delivered / delivered.length : 0, averageMinutes: mean(v.minutes) }))
      .sort((a, b) => b.delivered - a.delivered || b.sales - a.sales),
    byRider: [...perRider.entries()]
      .map(([name, v]) => ({ name, delivered: v.delivered, cash: v.cash, earned: v.earned, averageRideMinutes: mean(v.ride) }))
      .sort((a, b) => b.delivered - a.delivered),
    riderPay: delivered.reduce((sum, o) => sum + (o.deliveryPay ?? 0), 0),
    recent: delivered.slice(0, 8).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      place: o.deliveryLocationName,
      customerName: o.customerName,
      grandTotal: o.grandTotal,
      deliveredAt: (o.servedAt ?? o.placedAt).toISOString(),
      minutes: minutesBetween(o.placedAt, o.servedAt),
      paidBy: o.payments.length ? [...new Set(o.payments.map((p) => METHOD_LABEL[p.method] ?? p.method))].join(', ') : 'Unpaid',
    })),
  }
}
