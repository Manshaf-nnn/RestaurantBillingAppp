import 'server-only'

import type { DateRange } from '@/features/reports/range'
import { getProfitReport } from '@/features/reports/profit'
import { getPaymentsReport, getSalesReport } from '@/features/reports/sales'
import { getSupplierBalances } from '@/features/suppliers/ledger'
import { prisma } from '@/server/db/prisma'

/**
 * The accountant's dashboard (accountsds.md §2): one screen answering the
 * §17 questions, composed ENTIRELY from the authoritative engines — this file
 * computes no formula of its own. Revenue ≠ payments ≠ purchases ≠ COGS ≠
 * expenses ≠ cash, and each figure links to the screen that explains it.
 */

export interface AccountingHub {
  sales: {
    grossSales: number
    discounts: number
    refunds: number
    netSales: number
    tax: number
    serviceCharge: number
    tips: number
    /** What the guests were billed: net + tax + service. */
    totalBilled: number
  }
  collections: {
    byMethod: Array<{ method: string; label: string; amount: number }>
    collected: number
    refunded: number
    outstanding: number
  }
  profit: {
    /** The profit engine's own revenue base — ties to netSales by §102. */
    revenue: number
    cogs: number
    grossProfit: number
    grossMarginPercent: number | null
    /**
     * Share of sold lines that carried a recipe cost — the margin's blind
     * spot, straight off the profit report's coverage panel.
     */
    coveragePercent: number
    /** Best earners and thinnest margins (≥5 sold), straight off byItem. */
    topItems: Array<{ label: string; grossProfit: number; marginPercent: number | null }>
    lowMarginItems: Array<{ label: string; grossProfit: number; marginPercent: number | null }>
  }
  purchasing: {
    /** Goods actually received in the period, at cost — NOT COGS. */
    receivedValue: number
    payablesOutstanding: number
    supplierPaymentsPaid: number
  }
  expenses: {
    paid: number
    pendingApproval: number
    approvedUnpaid: number
    byCategory: Array<{ category: string; amount: number }>
  }
  inventory: { stockValueNow: number; wasteValue: number }
  cash: { drawerVariance: number; drawersClosed: number }
}

export async function getAccountingHub(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<AccountingHub> {
  const { restaurantId, range, branchIds } = params
  const atBranch = branchIds ? { branchId: { in: branchIds } } : {}

  const [sales, payments, profit, balances, receipts, supplierPaid, expensesPaid, expensesPending, expensesApproved, byCategory, stock, waste, outstandingAgg] =
    await Promise.all([
      getSalesReport({ restaurantId, range, branchIds }),
      getPaymentsReport({ restaurantId, range, branchIds }),
      getProfitReport({ restaurantId, range, branchIds }),
      getSupplierBalances(restaurantId, branchIds ?? null),
      prisma.goodsReceipt.findMany({
        where: {
          restaurantId,
          receivedAt: { gte: range.from, lte: range.to },
          ...atBranch,
        },
        select: { lines: { select: { acceptedQty: true, unitCost: true } } },
      }),
      prisma.supplierPayment.aggregate({
        where: {
          restaurantId,
          paidAt: { gte: range.from, lte: range.to },
          ...(branchIds
            ? { OR: [{ purchase: { branchId: { in: branchIds } } }, { purchaseId: null }] }
            : {}),
        },
        _sum: { amount: true },
      }),
      prisma.outgoingPayment.aggregate({
        where: {
          restaurantId, kind: 'EXPENSE', status: 'PAID',
          paymentDate: { gte: range.from, lte: range.to }, ...atBranch,
        },
        _sum: { amount: true },
      }),
      prisma.outgoingPayment.aggregate({
        where: { restaurantId, status: 'SUBMITTED', ...atBranch },
        _sum: { amount: true },
      }),
      prisma.outgoingPayment.aggregate({
        where: { restaurantId, status: 'APPROVED', ...atBranch },
        _sum: { amount: true },
      }),
      prisma.outgoingPayment.groupBy({
        by: ['expenseCategoryId'],
        where: {
          restaurantId, kind: 'EXPENSE', status: 'PAID',
          paymentDate: { gte: range.from, lte: range.to }, ...atBranch,
        },
        _sum: { amount: true },
      }),
      prisma.inventoryItem.aggregate({
        where: { restaurantId, isActive: true },
        _sum: { stockValue: true },
      }),
      prisma.wastageRecord.aggregate({
        where: {
          restaurantId,
          createdAt: { gte: range.from, lte: range.to },
          ...atBranch,
        },
        _sum: { costValue: true },
      }),
      prisma.order.aggregate({
        where: {
          restaurantId,
          status: { not: 'CANCELLED' },
          paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
          placedAt: { gte: range.from, lte: range.to },
          ...atBranch,
        },
        _sum: { grandTotal: true, tipAmount: true, paidTotal: true },
      }),
    ])

  const categoryIds = byCategory
    .map((row) => row.expenseCategoryId)
    .filter((id): id is string => Boolean(id))
  const categoryNames = categoryIds.length
    ? new Map(
        (
          await prisma.expenseCategory.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true, name: true },
          })
        ).map((row) => [row.id, row.name]),
      )
    : new Map<string, string>()

  const payables = [...balances.values()].reduce((sum, value) => sum + Math.max(0, value), 0)
  const receivedValue = receipts.reduce(
    (sum, receipt) =>
      sum + receipt.lines.reduce((s, line) => s + Math.round(line.acceptedQty * line.unitCost), 0),
    0,
  )

  return {
    sales: {
      grossSales: sales.totals.grossSales,
      discounts: sales.totals.discounts,
      refunds: sales.totals.refunds,
      netSales: sales.totals.netSales,
      tax: sales.totals.tax,
      serviceCharge: sales.totals.serviceCharge,
      tips: sales.totals.tips,
      totalBilled: sales.totals.netSales + sales.totals.tax + sales.totals.serviceCharge,
    },
    collections: {
      byMethod: payments.byMethod.map((row) => ({
        method: row.method,
        label: row.label,
        amount: row.amount,
      })),
      collected: payments.total - payments.refunded,
      refunded: payments.refunded,
      outstanding: Math.max(
        0,
        (outstandingAgg._sum.grandTotal ?? 0) +
          (outstandingAgg._sum.tipAmount ?? 0) -
          (outstandingAgg._sum.paidTotal ?? 0),
      ),
    },
    profit: {
      revenue: profit.totals.revenue,
      cogs: profit.totals.cogs,
      grossProfit: profit.totals.grossProfit,
      grossMarginPercent:
        profit.totals.revenue > 0
          ? Math.round((profit.totals.grossProfit / profit.totals.revenue) * 1000) / 10
          : null,
      coveragePercent: profit.coverage.percentCovered,
      topItems: [...profit.byItem]
        .filter((row) => row.quantity >= 5)
        .sort((a, b) => b.grossProfit - a.grossProfit)
        .slice(0, 5)
        .map((row) => ({ label: row.label, grossProfit: row.grossProfit, marginPercent: row.grossMarginPercent })),
      lowMarginItems: [...profit.byItem]
        .filter((row) => row.quantity >= 5 && row.revenue > 0)
        .sort((a, b) => (a.grossMarginPercent ?? 0) - (b.grossMarginPercent ?? 0))
        .slice(0, 5)
        .map((row) => ({ label: row.label, grossProfit: row.grossProfit, marginPercent: row.grossMarginPercent })),
    },
    purchasing: {
      receivedValue,
      payablesOutstanding: payables,
      supplierPaymentsPaid: supplierPaid._sum.amount ?? 0,
    },
    expenses: {
      paid: expensesPaid._sum.amount ?? 0,
      pendingApproval: expensesPending._sum.amount ?? 0,
      approvedUnpaid: expensesApproved._sum.amount ?? 0,
      byCategory: byCategory
        .map((row) => ({
          category: row.expenseCategoryId
            ? (categoryNames.get(row.expenseCategoryId) ?? 'Uncategorised')
            : 'Uncategorised',
          amount: row._sum.amount ?? 0,
        }))
        .sort((a, b) => b.amount - a.amount),
    },
    inventory: {
      stockValueNow: Math.round(Number(stock._sum.stockValue ?? 0)),
      wasteValue: waste._sum.costValue ?? 0,
    },
    cash: {
      drawerVariance: payments.cashDiscrepancy,
      drawersClosed: payments.drawersClosed,
    },
  }
}
