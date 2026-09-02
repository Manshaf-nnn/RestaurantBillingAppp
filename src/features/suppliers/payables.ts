import 'server-only'

import type { DateRange } from '@/features/reports/range'
import { prisma } from '@/server/db/prisma'

/**
 * The supplier statement, over a period (accountsds.md §4).
 *
 * Same arithmetic as the ledger — receipts at accepted×cost make the debt,
 * payments and returns retire it, on-order stays out — and the same scope
 * rules verbatim: receipts and returns carry a branch of their own, while a
 * payment reaches a location through the purchase it settles, with
 * payments-on-account visible everywhere because hiding business-level money
 * makes the running balance stop adding up. The statement never re-derives a
 * balance the ledger would disagree with: closing here equals
 * `getSupplierBalances` when the range ends now, and the tests pin that.
 *
 * Aging allocates settlements FIFO against the oldest receipts as of the
 * range end — the standard treatment — so "90+ days" means real unpaid
 * deliveries, not an average.
 */

export interface SupplierStatementRow {
  supplierId: string
  supplierName: string
  opening: number
  received: number
  returned: number
  paid: number
  closing: number
  aging: { current: number; d31to60: number; d61to90: number; d90plus: number }
}

export interface PayablesStatement {
  rows: SupplierStatementRow[]
  totals: Omit<SupplierStatementRow, 'supplierId' | 'supplierName'>
}

export async function getPayablesStatement(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  supplierId?: string
}): Promise<PayablesStatement> {
  const reach = params.branchIds ?? null
  const atBranch = reach ? { branchId: { in: reach } } : {}
  const paymentScope = reach
    ? { OR: [{ purchase: { branchId: { in: reach } } }, { purchaseId: null }] }
    : {}
  const supplierScope = params.supplierId ? { id: params.supplierId } : {}

  const suppliers = await prisma.supplier.findMany({
    where: { restaurantId: params.restaurantId, ...supplierScope },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  if (suppliers.length === 0) {
    return {
      rows: [],
      totals: {
        opening: 0, received: 0, returned: 0, paid: 0, closing: 0,
        aging: { current: 0, d31to60: 0, d61to90: 0, d90plus: 0 },
      },
    }
  }
  const supplierIds = suppliers.map((supplier) => supplier.id)

  const [receipts, payments, returns] = await Promise.all([
    prisma.goodsReceipt.findMany({
      where: {
        restaurantId: params.restaurantId,
        purchase: { supplierId: { in: supplierIds } },
        receivedAt: { lte: params.range.to },
        ...atBranch,
      },
      select: {
        receivedAt: true,
        purchase: { select: { supplierId: true } },
        lines: { select: { acceptedQty: true, unitCost: true } },
      },
      orderBy: { receivedAt: 'asc' },
    }),
    prisma.supplierPayment.findMany({
      where: {
        restaurantId: params.restaurantId,
        supplierId: { in: supplierIds },
        paidAt: { lte: params.range.to },
        ...paymentScope,
      },
      select: { supplierId: true, amount: true, paidAt: true },
    }),
    prisma.purchaseReturn.findMany({
      where: {
        restaurantId: params.restaurantId,
        supplierId: { in: supplierIds },
        createdAt: { lte: params.range.to },
        ...atBranch,
      },
      select: {
        supplierId: true,
        createdAt: true,
        lines: { select: { quantity: true, unitCost: true } },
      },
    }),
  ])

  const rows: SupplierStatementRow[] = []

  for (const supplier of suppliers) {
    const myReceipts = receipts
      .filter((receipt) => receipt.purchase?.supplierId === supplier.id)
      .map((receipt) => ({
        at: receipt.receivedAt,
        value: receipt.lines.reduce(
          (sum, line) => sum + Math.round(line.acceptedQty * line.unitCost),
          0,
        ),
      }))
    const myPayments = payments.filter((payment) => payment.supplierId === supplier.id)
    const myReturns = returns
      .filter((row) => row.supplierId === supplier.id)
      .map((row) => ({
        at: row.createdAt,
        value: row.lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCost), 0),
      }))

    const before = (at: Date) => at < params.range.from
    const opening =
      myReceipts.filter((r) => before(r.at)).reduce((sum, r) => sum + r.value, 0) -
      myPayments.filter((p) => before(p.paidAt)).reduce((sum, p) => sum + p.amount, 0) -
      myReturns.filter((r) => before(r.at)).reduce((sum, r) => sum + r.value, 0)

    const received = myReceipts.filter((r) => !before(r.at)).reduce((sum, r) => sum + r.value, 0)
    const paid = myPayments.filter((p) => !before(p.paidAt)).reduce((sum, p) => sum + p.amount, 0)
    const returned = myReturns.filter((r) => !before(r.at)).reduce((sum, r) => sum + r.value, 0)
    const closing = opening + received - paid - returned

    /*
     * Aging: settle the oldest deliveries first with everything ever paid or
     * returned up to the range end, then bucket what is left by how long it
     * has waited. Negative balances (overpayment) age nothing.
     */
    let settled =
      myPayments.reduce((sum, p) => sum + p.amount, 0) +
      myReturns.reduce((sum, r) => sum + r.value, 0)
    const aging = { current: 0, d31to60: 0, d61to90: 0, d90plus: 0 }
    for (const receipt of myReceipts) {
      const unpaid = Math.max(0, receipt.value - settled)
      settled = Math.max(0, settled - receipt.value)
      if (unpaid === 0) continue
      const ageDays = Math.floor(
        (params.range.to.getTime() - receipt.at.getTime()) / 86_400_000,
      )
      if (ageDays <= 30) aging.current += unpaid
      else if (ageDays <= 60) aging.d31to60 += unpaid
      else if (ageDays <= 90) aging.d61to90 += unpaid
      else aging.d90plus += unpaid
    }

    if (
      opening === 0 && received === 0 && paid === 0 && returned === 0 && closing === 0
    ) {
      continue // a supplier with no money story clutters the statement
    }

    rows.push({
      supplierId: supplier.id,
      supplierName: supplier.name,
      opening,
      received,
      returned,
      paid,
      closing,
      aging,
    })
  }

  rows.sort((a, b) => b.closing - a.closing)

  const totals = rows.reduce(
    (sum, row) => ({
      opening: sum.opening + row.opening,
      received: sum.received + row.received,
      returned: sum.returned + row.returned,
      paid: sum.paid + row.paid,
      closing: sum.closing + row.closing,
      aging: {
        current: sum.aging.current + row.aging.current,
        d31to60: sum.aging.d31to60 + row.aging.d31to60,
        d61to90: sum.aging.d61to90 + row.aging.d61to90,
        d90plus: sum.aging.d90plus + row.aging.d90plus,
      },
    }),
    {
      opening: 0, received: 0, returned: 0, paid: 0, closing: 0,
      aging: { current: 0, d31to60: 0, d61to90: 0, d90plus: 0 },
    },
  )

  return { rows, totals }
}
