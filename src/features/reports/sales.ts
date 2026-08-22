import 'server-only'

import { prisma } from '@/server/db/prisma'
import type { DateRange } from './range'

/**
 * Sales reporting.
 *
 * ── What counts as a sale ───────────────────────────────────────────────────
 *
 * Cancelled orders are excluded entirely; refunded ones are included at their
 * original value with the refund shown separately. Netting a refund off the day
 * it was *given* rather than the day of the sale is what makes a report
 * disagree with the till, so both figures are reported rather than merged.
 *
 * ── Gross vs net ────────────────────────────────────────────────────────────
 *
 *   gross = the sum of what was sold before anything is taken off
 *   net   = gross − discounts − refunds, still before tax
 *
 * Tax and service charge are reported alongside, never folded into net, because
 * neither is the restaurant's money.
 */

export interface SalesTotals {
  grossSales: number
  discounts: number
  refunds: number
  netSales: number
  tax: number
  serviceCharge: number
  tips: number
  /** What actually landed: net + tax + service. */
  collected: number
  orders: number
  guests: number
  averageOrderValue: number
}

export interface Bucket {
  key: string
  label: string
  sales: number
  orders: number
}

export interface SalesReport {
  range: { from: string; to: string; label: string }
  totals: SalesTotals
  byHour: Bucket[]
  byDay: Bucket[]
  byCategory: Bucket[]
  byItem: Array<Bucket & { quantity: number }>
  byBranch: Bucket[]
  byEmployee: Bucket[]
  byType: Bucket[]
}

export async function getSalesReport(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<SalesReport> {
  const where = {
    restaurantId: params.restaurantId,
    status: { not: 'CANCELLED' as const },
    placedAt: { gte: params.range.from, lte: params.range.to },
    ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
  }

  const orders = await prisma.order.findMany({
    where,
    select: {
      id: true, subtotal: true, discountTotal: true, loyaltyDiscount: true,
      taxTotal: true, serviceCharge: true, tipAmount: true, grandTotal: true,
      paymentStatus: true, paidTotal: true, guestCount: true, type: true,
      placedAt: true,
      branch: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      servedBy: { select: { id: true, name: true } },
      items: {
        where: { status: { not: 'CANCELLED' } },
        select: {
          name: true, quantity: true, lineTotal: true,
          food: { select: { category: { select: { id: true, name: true } } } },
        },
      },
    },
  })

  // Refunds are attributed to the order they belong to, not the day they were
  // given, so a report always reconciles against the bill it describes.
  const refunded = await prisma.payment.aggregate({
    where: {
      restaurantId: params.restaurantId,
      status: 'REFUNDED',
      order: { placedAt: { gte: params.range.from, lte: params.range.to } },
    },
    _sum: { amount: true },
  })

  let grossSales = 0, discounts = 0, tax = 0, serviceCharge = 0, tips = 0, guests = 0
  const hour = new Map<string, { sales: number; orders: number }>()
  const day = new Map<string, { sales: number; orders: number }>()
  const category = new Map<string, { label: string; sales: number; orders: number }>()
  const item = new Map<string, { label: string; sales: number; orders: number; quantity: number }>()
  const branch = new Map<string, { label: string; sales: number; orders: number }>()
  const employee = new Map<string, { label: string; sales: number; orders: number }>()
  const type = new Map<string, { sales: number; orders: number }>()

  const bump = <T extends { sales: number; orders: number }>(
    map: Map<string, T>, key: string, make: () => T, sales: number,
  ) => {
    const row = map.get(key) ?? make()
    row.sales += sales
    row.orders += 1
    map.set(key, row)
  }

  for (const o of orders) {
    const lineValue = o.subtotal
    grossSales += lineValue
    discounts += o.discountTotal + o.loyaltyDiscount
    tax += o.taxTotal
    serviceCharge += o.serviceCharge
    tips += o.tipAmount
    guests += o.guestCount ?? 0

    const h = String(o.placedAt.getHours()).padStart(2, '0')
    bump(hour, h, () => ({ sales: 0, orders: 0 }), lineValue)
    bump(day, o.placedAt.toISOString().slice(0, 10), () => ({ sales: 0, orders: 0 }), lineValue)
    bump(type, o.type, () => ({ sales: 0, orders: 0 }), lineValue)
    bump(branch, o.branch?.id ?? 'none',
      () => ({ label: o.branch?.name ?? 'Unassigned', sales: 0, orders: 0 }), lineValue)
    // Credit the person serving the table, not whoever keyed it in. A cashier
    // ringing up a waiter's order should not appear as the top seller.
    const attributed = o.servedBy ?? o.createdBy
    if (attributed) {
      bump(employee, attributed.id,
        () => ({ label: attributed.name, sales: 0, orders: 0 }), lineValue)
    }

    for (const line of o.items) {
      const catId = line.food?.category?.id ?? 'none'
      const catRow = category.get(catId) ?? {
        label: line.food?.category?.name ?? 'Uncategorised', sales: 0, orders: 0,
      }
      catRow.sales += line.lineTotal
      catRow.orders += 1
      category.set(catId, catRow)

      const itemRow = item.get(line.name) ?? { label: line.name, sales: 0, orders: 0, quantity: 0 }
      itemRow.sales += line.lineTotal
      itemRow.orders += 1
      itemRow.quantity += line.quantity
      item.set(line.name, itemRow)
    }
  }

  const refunds = refunded._sum?.amount ?? 0
  const netSales = grossSales - discounts - refunds

  const toBuckets = (m: Map<string, { label?: string; sales: number; orders: number }>) =>
    [...m.entries()]
      .map(([key, v]) => ({ key, label: v.label ?? key, sales: v.sales, orders: v.orders }))
      .sort((a, b) => b.sales - a.sales)

  return {
    range: {
      from: params.range.from.toISOString(),
      to: params.range.to.toISOString(),
      label: params.range.label,
    },
    totals: {
      grossSales,
      discounts,
      refunds,
      netSales,
      tax,
      serviceCharge,
      tips,
      collected: netSales + tax + serviceCharge,
      orders: orders.length,
      guests,
      averageOrderValue: orders.length > 0 ? Math.round(netSales / orders.length) : 0,
    },
    // Hours and days read chronologically; everything else biggest first.
    byHour: toBuckets(hour).sort((a, b) => a.key.localeCompare(b.key))
      .map((b) => ({ ...b, label: `${b.key}:00` })),
    byDay: toBuckets(day).sort((a, b) => a.key.localeCompare(b.key)),
    byCategory: toBuckets(category),
    byItem: [...item.entries()]
      .map(([key, v]) => ({ key, label: v.label, sales: v.sales, orders: v.orders, quantity: v.quantity }))
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 50),
    byBranch: toBuckets(branch),
    byEmployee: toBuckets(employee),
    byType: toBuckets(type).map((b) => ({ ...b, label: b.key.replace(/_/g, ' ').toLowerCase() })),
  }
}

export interface PaymentsReport {
  byMethod: Array<{ method: string; label: string; amount: number; count: number; share: number }>
  total: number
  refunded: number
  /** Cash counted in drawers minus cash the system recorded. */
  cashDiscrepancy: number
  drawersClosed: number
}

/**
 * Payment mix, and whether the cash actually balanced.
 *
 * The discrepancy figure is the sum of drawer variances over the period. It is
 * reported separately from takings rather than adjusted into them: a till that
 * was short by 500 still took what it took, and hiding the difference inside
 * revenue is how a shortfall stops being noticed.
 */
export async function getPaymentsReport(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<PaymentsReport> {
  const [payments, drawers] = await Promise.all([
    prisma.payment.groupBy({
      by: ['method', 'status'],
      where: {
        restaurantId: params.restaurantId,
        paidAt: { gte: params.range.from, lte: params.range.to },
        status: { in: ['PAID', 'REFUNDED'] },
        // The cash-variance figure ten lines below was already branch-scoped
        // and this was not, so the two halves of the same panel could never be
        // reconciled against each other.
        ...(params.branchIds ? { order: { branchId: { in: params.branchIds } } } : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.cashDrawerSession.findMany({
      where: {
        restaurantId: params.restaurantId,
        status: 'CLOSED',
        closedAt: { gte: params.range.from, lte: params.range.to },
        ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      },
      select: { variance: true },
    }),
  ])

  const paid = payments.filter((p) => p.status === 'PAID')
  const total = paid.reduce((s, p) => s + (p._sum?.amount ?? 0), 0)
  const refunded = payments
    .filter((p) => p.status === 'REFUNDED')
    .reduce((s, p) => s + (p._sum?.amount ?? 0), 0)

  const LABELS: Record<string, string> = {
    CASH: 'Cash', CARD: 'Card', QR: 'QR', ONLINE: 'Online',
    WALLET: 'Wallet', BANK_TRANSFER: 'Bank transfer',
  }

  return {
    total,
    refunded,
    byMethod: paid
      .map((p) => ({
        method: p.method,
        label: LABELS[p.method] ?? p.method,
        amount: p._sum?.amount ?? 0,
        count: p._count,
        share: total > 0 ? Math.round(((p._sum?.amount ?? 0) / total) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount),
    cashDiscrepancy: drawers.reduce((s, d) => s + (d.variance ?? 0), 0),
    drawersClosed: drawers.length,
  }
}
