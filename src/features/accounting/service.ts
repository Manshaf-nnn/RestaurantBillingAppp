import 'server-only'

import type { Prisma } from '@prisma/client'

import { getProfitReport } from '@/features/reports/profit'
import { RANGE_LABELS, startOfDay, type DateRange } from '@/features/reports/range'
import { getPaymentsReport, getSalesReport } from '@/features/reports/sales'
import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * The daily close and accounting periods (§50–51, §59).
 *
 * A restaurant's day does not end when the clock does — it ends when somebody
 * responsible looks at the figures and signs them. `closeDay` freezes the §51
 * accountant report for one local business date as a snapshot nothing can
 * rewrite; `closePeriod` then seals a signed range so the orders inside it
 * refuse cancellation, voids and discount edits. The figures an accountant has
 * filed must not quietly change under them — that is the entire mechanism.
 *
 * No cron anywhere, by house rule: a day is closed when a person closes it,
 * and an unclosed yesterday shows on the screen as exactly that.
 */

/** A local calendar date as midnight UTC — the storable identity of a day. */
export function businessDateOf(at: Date, timeZone: string): Date {
  const local = startOfDay(at, timeZone)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  void local
  return new Date(`${parts}T00:00:00.000Z`)
}

/** The UTC window one local business date spans. */
export function dayRange(businessDate: Date, timeZone: string): DateRange {
  const iso = businessDate.toISOString().slice(0, 10)
  const noonUtc = new Date(`${iso}T12:00:00.000Z`)
  const from = startOfDay(noonUtc, timeZone)
  const to = new Date(startOfDay(new Date(from.getTime() + 36 * 3_600_000), timeZone).getTime() - 1)
  return { from, to, preset: 'CUSTOM', label: RANGE_LABELS.CUSTOM, timeZone, granularity: 'hour' }
}

export interface DailyCloseSnapshot {
  businessDate: string
  timeZone: string
  sales: {
    grossSales: number
    discounts: number
    refunds: number
    netSales: number
    tax: number
    serviceCharge: number
    tips: number
    orders: number
  }
  payments: {
    collected: number
    refunded: number
    byMethod: Array<{ method: string; label: string; amount: number; count: number }>
    cashDiscrepancy: number
    drawersClosed: number
  }
  profit: { cogs: number; grossProfit: number }
  outstanding: number
}

/** The §51 accountant daily report, composed from the unified modules. */
export async function buildDailySnapshot(params: {
  restaurantId: string
  businessDate: Date
  timeZone: string
  branchIds?: string[] | null
}): Promise<DailyCloseSnapshot> {
  const range = dayRange(params.businessDate, params.timeZone)

  const [sales, payments, profit, outstanding] = await Promise.all([
    getSalesReport({ restaurantId: params.restaurantId, range, branchIds: params.branchIds }),
    getPaymentsReport({ restaurantId: params.restaurantId, range, branchIds: params.branchIds }),
    getProfitReport({ restaurantId: params.restaurantId, range, branchIds: params.branchIds }),
    prisma.order.aggregate({
      where: {
        restaurantId: params.restaurantId,
        status: { not: 'CANCELLED' },
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
        placedAt: { gte: range.from, lte: range.to },
        ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      },
      _sum: { grandTotal: true, tipAmount: true, paidTotal: true },
    }),
  ])

  return {
    businessDate: params.businessDate.toISOString().slice(0, 10),
    timeZone: params.timeZone,
    sales: {
      grossSales: sales.totals.grossSales,
      discounts: sales.totals.discounts,
      refunds: sales.totals.refunds,
      netSales: sales.totals.netSales,
      tax: sales.totals.tax,
      serviceCharge: sales.totals.serviceCharge,
      tips: sales.totals.tips,
      orders: sales.totals.orders,
    },
    payments: {
      collected: payments.total - payments.refunded,
      refunded: payments.refunded,
      byMethod: payments.byMethod.map((row) => ({
        method: row.method,
        label: row.label,
        amount: row.amount,
        count: row.count,
      })),
      cashDiscrepancy: payments.cashDiscrepancy,
      drawersClosed: payments.drawersClosed,
    },
    profit: { cogs: profit.totals.cogs, grossProfit: profit.totals.grossProfit },
    outstanding: Math.max(
      0,
      (outstanding._sum.grandTotal ?? 0) +
        (outstanding._sum.tipAmount ?? 0) -
        (outstanding._sum.paidTotal ?? 0),
    ),
  }
}

export async function closeDay(params: {
  restaurantId: string
  businessDate: Date
  timeZone: string
  userId: string
  notes?: string | null
}) {
  const today = businessDateOf(new Date(), params.timeZone)
  if (params.businessDate.getTime() >= today.getTime()) {
    throw new AppError(
      'A day can only be closed once it is over — close it tomorrow',
      400,
      'DAY_NOT_OVER',
    )
  }

  const existing = await prisma.dailyClose.findFirst({
    where: {
      restaurantId: params.restaurantId,
      branchId: null,
      businessDate: params.businessDate,
    },
  })
  if (existing) {
    throw new AppError('That day is already closed', 409, 'DAY_CLOSED')
  }

  const snapshot = await buildDailySnapshot({
    restaurantId: params.restaurantId,
    businessDate: params.businessDate,
    timeZone: params.timeZone,
  })

  return prisma.dailyClose.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: null,
      businessDate: params.businessDate,
      closedById: params.userId,
      notes: params.notes?.trim() || null,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  })
}

// ── accounting periods (§59) ─────────────────────────────────────────────────

export async function closePeriod(params: {
  restaurantId: string
  from: Date
  to: Date
  userId: string
  notes?: string | null
}) {
  if (params.from >= params.to) {
    throw new AppError('The period must start before it ends', 400, 'PERIOD_INVERTED')
  }
  if (params.to > new Date()) {
    throw new AppError(
      'A period cannot be closed while it is still happening',
      400,
      'PERIOD_NOT_OVER',
    )
  }

  const overlapping = await prisma.accountingPeriod.findFirst({
    where: {
      restaurantId: params.restaurantId,
      status: 'CLOSED',
      periodStart: { lt: params.to },
      periodEnd: { gt: params.from },
    },
  })
  if (overlapping) {
    throw new AppError('That range overlaps a period that is already closed', 409, 'PERIOD_OVERLAP')
  }

  return prisma.accountingPeriod.create({
    data: {
      restaurantId: params.restaurantId,
      periodStart: params.from,
      periodEnd: params.to,
      status: 'CLOSED',
      closedById: params.userId,
      notes: params.notes?.trim() || null,
    },
  })
}

export async function reopenPeriod(params: {
  restaurantId: string
  periodId: string
  userId: string
}) {
  const period = await prisma.accountingPeriod.findFirst({
    where: { id: params.periodId, restaurantId: params.restaurantId },
  })
  if (!period) throw new NotFoundError('Accounting period')
  if (period.status !== 'CLOSED') {
    throw new AppError('That period is not closed', 409, 'PERIOD_NOT_CLOSED')
  }
  return prisma.accountingPeriod.update({
    where: { id: period.id },
    data: { status: 'REOPENED', reopenedById: params.userId, reopenedAt: new Date() },
  })
}

/**
 * Refuse to change history the books have signed off (§59).
 *
 * `at` is the moment the record being edited belongs to — an order's
 * placedAt, a movement's createdAt. New events dated NOW (a refund given
 * today for January's bill) are deliberately not blocked: they land in
 * today's open period, which is how accounting corrections work.
 *
 * `what` names the thing being refused, because this guard now covers money
 * and stock as well as orders and "This order belongs to…" was the wrong
 * sentence to show a storekeeper receiving goods.
 */
export async function assertPeriodOpen(
  db: { accountingPeriod: { findFirst: (args: never) => Promise<unknown> } } | typeof prisma,
  restaurantId: string,
  at: Date,
  what = 'This order',
): Promise<void> {
  const sealed = await (db as typeof prisma).accountingPeriod.findFirst({
    where: {
      restaurantId,
      status: 'CLOSED',
      periodStart: { lte: at },
      periodEnd: { gt: at },
    },
    select: { periodStart: true, periodEnd: true },
  })
  if (sealed) {
    throw new AppError(
      `${what} belongs to a closed accounting period. The books for that range were signed off — reopen the period first if it genuinely has to change.`,
      409,
      'PERIOD_CLOSED',
    )
  }
}
