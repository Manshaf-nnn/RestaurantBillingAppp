import 'server-only'

import type { DateRange } from '@/features/reports/range'
import { getProfitReport } from '@/features/reports/profit'
import { getReconciliationReport } from '@/features/reports/reconciliation'
import { getPaymentsReport, getSalesReport } from '@/features/reports/sales'
import { getSupplierBalances } from '@/features/suppliers/ledger'
import { getPayablesStatement } from '@/features/suppliers/payables'
import { prisma } from '@/server/db/prisma'
import { runIntegrityChecks, type IntegrityReport, type IntegrityStatus } from './integrity'

/**
 * Financial reconciliation (accountsds.md §11): the money identities, checked
 * live, each row saying OK / WARNING / ERROR and where to look. Two layers:
 *
 *   1. the §115 integrity checker — row-level questions the database should
 *      never answer yes to (now including the money-out workflow), and
 *   2. the IDENTITIES — both sides of each accounting equation computed
 *      through the authoritative engines and compared to the minor unit.
 *
 * Nothing here re-derives a formula: each side of every identity is a call
 * into the module that owns it, which is exactly why a mismatch means
 * something is genuinely wrong rather than "two screens compute differently".
 */

export interface IdentityRow {
  key: string
  label: string
  /** e.g. "net sales 412,300 = gross 450,000 − discounts 20,000 − refunds 17,700" */
  working: string
  status: IntegrityStatus
  href: string
}

export interface FinancialReconciliation {
  integrity: IntegrityReport
  identities: IdentityRow[]
  status: IntegrityStatus
}

export async function getFinancialReconciliation(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<FinancialReconciliation> {
  const { restaurantId, range, branchIds } = params
  const atBranch = branchIds ? { branchId: { in: branchIds } } : {}

  const [integrity, sales, payments, profit, ladder, balances, statement, saleMovements, outstandingAgg, paymentRows] =
    await Promise.all([
      runIntegrityChecks(restaurantId),
      getSalesReport({ restaurantId, range, branchIds }),
      getPaymentsReport({ restaurantId, range, branchIds }),
      getProfitReport({ restaurantId, range, branchIds }),
      getReconciliationReport({ restaurantId, range, branchId: branchIds?.length === 1 ? branchIds[0] : null }),
      getSupplierBalances(restaurantId, branchIds ?? null),
      getPayablesStatement({ restaurantId, range, branchIds }),
      prisma.$queryRaw<Array<{ value: bigint | null }>>`
        SELECT SUM(ABS(quantity) * "unitCost")::bigint AS value
        FROM stock_movements
        WHERE "restaurantId" = ${restaurantId}
          AND type = 'SALE'
          AND "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
      `,
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
      prisma.payment.aggregate({
        where: {
          restaurantId,
          status: { in: ['PAID', 'REFUNDED'] },
          paidAt: { gte: range.from, lte: range.to },
          ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}),
        },
        _sum: { amount: true },
      }),
    ])

  const identities: IdentityRow[] = []
  const push = (
    key: string,
    label: string,
    left: number,
    right: number,
    working: string,
    href: string,
    tolerance = 0,
  ) => {
    identities.push({
      key,
      label,
      working,
      status: Math.abs(left - right) <= tolerance ? 'OK' : 'ERROR',
      href,
    })
  }

  // Net sales = gross − discounts − refunds (the §110 definition, restated).
  push(
    'net-sales',
    'Net sales = gross − discounts − refunds',
    sales.totals.netSales,
    sales.totals.grossSales - sales.totals.discounts - sales.totals.refunds,
    `${sales.totals.netSales} = ${sales.totals.grossSales} − ${sales.totals.discounts} − ${sales.totals.refunds}`,
    '/dashboard/reports/sales',
  )

  // Payments report total = the payment ledger's own sum for the same window.
  push(
    'collections',
    'Collections report = payment ledger',
    payments.total,
    paymentRows._sum.amount ?? 0,
    `report ${payments.total} vs ledger ${paymentRows._sum.amount ?? 0}`,
    '/dashboard/reports/sales',
  )

  // Outstanding = billed − net payments, per open bill.
  const outstanding = Math.max(
    0,
    (outstandingAgg._sum.grandTotal ?? 0) +
      (outstandingAgg._sum.tipAmount ?? 0) -
      (outstandingAgg._sum.paidTotal ?? 0),
  )
  identities.push({
    key: 'outstanding',
    label: 'Outstanding = billed − net payments',
    working: `${outstanding} across unpaid and part-paid bills in the period`,
    // paidTotal integrity (billed vs ledger) is asserted row-level by the
    // checker; this row exists to show WHERE the figure comes from.
    status: integrity.checks.find((check) => check.key === 'paid-total')?.status ?? 'OK',
    href: '/dashboard/invoices',
  })

  // Gross profit = net sales(profit basis) − COGS — pure arithmetic restated.
  push(
    'gross-profit',
    'Gross profit = revenue − COGS',
    profit.totals.grossProfit,
    profit.totals.revenue - profit.totals.cogs,
    `${profit.totals.grossProfit} = ${profit.totals.revenue} − ${profit.totals.cogs}`,
    '/dashboard/reports/profit',
  )

  // COGS ≈ what the stock ledger says left the kitchen at cost. Snapshot
  // costing and movement costing round independently per line, so a small
  // tolerance is honest; a real divergence blows straight through it.
  const movementCogs = Number(saleMovements[0]?.value ?? 0)
  identities.push({
    key: 'cogs-consumption',
    label: 'COGS agrees with consumption at cost',
    working: `report ${profit.totals.cogs} vs stock ledger ${movementCogs}`,
    status:
      profit.totals.cogs === 0 && movementCogs === 0
        ? 'OK'
        : Math.abs(profit.totals.cogs - movementCogs) <=
            Math.max(100, Math.round(Math.max(profit.totals.cogs, movementCogs) * 0.02))
          ? 'OK'
          : 'WARNING',
    href: '/dashboard/inventory/ledger',
  })

  // Inventory ladder: opening + in − out = closing, zero drift.
  identities.push({
    key: 'inventory-ladder',
    label: 'Inventory: opening + in − out = closing',
    working: ladder.balanced
      ? `${ladder.totals.items} item(s), drift zero`
      : `${ladder.totals.drifting} item(s) drifting`,
    status: ladder.balanced ? 'OK' : 'ERROR',
    href: '/dashboard/reports/reconciliation',
  })

  // Supplier payables: statement closing (as of now) = live balances.
  const liveTotal = [...balances.values()].reduce((sum, value) => sum + value, 0)
  const rangeEndsNow = Math.abs(range.to.getTime() - Date.now()) < 26 * 3_600_000
  identities.push({
    key: 'payables',
    label: 'Supplier payables: statement = ledger balances',
    working: `statement ${statement.totals.closing} vs balances ${liveTotal}`,
    status: !rangeEndsNow || statement.totals.closing === liveTotal ? 'OK' : 'ERROR',
    href: '/dashboard/accounting/payables',
  })

  // Cash: expected vs counted, from the drawers that closed in the window.
  identities.push({
    key: 'cash-variance',
    label: 'Cash: expected = counted at close',
    working:
      payments.drawersClosed === 0
        ? 'no drawers closed in the period'
        : `${payments.drawersClosed} drawer(s), net variance ${payments.cashDiscrepancy}`,
    status:
      payments.cashDiscrepancy === 0 ? 'OK' : 'WARNING',
    href: '/dashboard/reports/cash-drawer',
  })

  const worst = (values: IntegrityStatus[]): IntegrityStatus =>
    values.includes('ERROR') ? 'ERROR' : values.includes('WARNING') ? 'WARNING' : 'OK'

  return {
    integrity,
    identities,
    status: worst([integrity.status, ...identities.map((row) => row.status)]),
  }
}
