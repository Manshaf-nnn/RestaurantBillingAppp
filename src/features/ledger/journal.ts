import 'server-only'

import type { DateRange } from '@/features/reports/range'
import { prisma } from '@/server/db/prisma'
import { accountForMethod, accountName, type AccountCode } from './accounts'

/**
 * The derived journal (acCal.md §9).
 *
 * TableFlow keeps single-entry operating records — orders, payments, goods
 * receipts, stock movements. This module PROJECTS those into balanced
 * double-entry journal entries at read time. There is no journal table and
 * no posting step, which is the whole point: there can be no second source
 * of truth to drift, and no way to write a journal line that no real event
 * produced.
 *
 * Every entry balances by construction (each is built as debits that mirror
 * credits), and `ledger-test` proves it anyway — plus the ties that matter:
 * revenue ≡ the sales report, payables ≡ the supplier ledger, COGS ≡ the
 * profit report.
 *
 * Deliberately NOT projected, so nothing is counted twice:
 *   • CASH_REFUND movements — the Refund row (J3) is the record.
 *   • PETTY_CASH_PAID / PETTY_FUND_TOPUP — the request (J9) is the record.
 *   • EXPENSE_PAID / EXPENSE_REVERSED — the OutgoingPayment (J8) is.
 *   • CASH_DROP, CASH_IN, ADDITIONAL_CASH and a session's opening float —
 *     cash moving between the business's own till, safe and change box. The
 *     business is no richer for carrying its own money across the room, and
 *     the safe is not modelled, so projecting these would invent cash. What
 *     the cash book therefore shows is TRADING cash: takings in, payouts
 *     out, banked out, and counted differences.
 *   • Transfers and production — inventory moving inside the business.
 *   • SALE / WASTAGE stock movements as VALUES — J4 and J10 carry those,
 *     priced by the recipe cost pinned at sale, which is the number the
 *     profit report uses.
 */

export interface JournalLine {
  account: AccountCode | string
  accountName: string
  debit: number
  credit: number
  /** A per-line dimension: payment method, expense category, supplier. */
  dimension?: string
}

export interface JournalEntry {
  id: string
  date: Date
  /** Which projection produced it: 'SALE', 'SETTLEMENT', 'GRN', … */
  sourceType: string
  sourceId: string
  narrative: string
  href: string
  lines: JournalLine[]
  /** Σ debits, which by construction equals Σ credits. */
  total: number
}

function entry(params: {
  id: string
  date: Date
  sourceType: string
  sourceId: string
  narrative: string
  href: string
  lines: Array<{ account: string; debit?: number; credit?: number; dimension?: string }>
}): JournalEntry | null {
  const lines: JournalLine[] = params.lines
    .filter((line) => (line.debit ?? 0) !== 0 || (line.credit ?? 0) !== 0)
    .map((line) => ({
      account: line.account,
      accountName: accountName(line.account),
      debit: line.debit ?? 0,
      credit: line.credit ?? 0,
      dimension: line.dimension,
    }))
  if (lines.length === 0) return null

  const debits = lines.reduce((sum, line) => sum + line.debit, 0)
  const credits = lines.reduce((sum, line) => sum + line.credit, 0)
  if (debits !== credits) {
    // Never silently publish an unbalanced entry: a rounding artefact goes to
    // 4910 where it can be seen and explained, exactly as a bill's rounding
    // adjustment does.
    const gap = debits - credits
    lines.push({
      account: '4910',
      accountName: accountName('4910'),
      debit: gap < 0 ? -gap : 0,
      credit: gap > 0 ? gap : 0,
      dimension: 'rounding',
    })
  }

  return {
    id: params.id,
    date: params.date,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    narrative: params.narrative,
    href: params.href,
    lines,
    total: lines.reduce((sum, line) => sum + line.debit, 0),
  }
}

const MAX_ROWS = 500

export async function buildJournal(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<JournalEntry[]> {
  const { restaurantId, range, branchIds } = params
  const within = { gte: range.from, lte: range.to }
  const atBranch = branchIds ? { branchId: { in: branchIds } } : {}
  const entries: JournalEntry[] = []

  const [orders, payments, refunds, receipts, supplierPayments, returns, outgoing, petty, wastage, adjustments, openings, cashMovements, drawers] =
    await Promise.all([
      prisma.order.findMany({
        where: { restaurantId, status: { not: 'CANCELLED' }, placedAt: within, ...atBranch },
        select: {
          id: true, orderNumber: true, placedAt: true, subtotal: true, discountTotal: true,
          loyaltyDiscount: true, taxTotal: true, serviceCharge: true, tipAmount: true,
          roundingAdj: true, grandTotal: true,
          items: { where: { status: { not: 'CANCELLED' } }, select: { costPrice: true, quantity: true } },
        },
        orderBy: { placedAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.payment.findMany({
        where: { restaurantId, status: { in: ['PAID', 'REFUNDED'] }, paidAt: within, ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}) },
        select: { id: true, amount: true, method: true, paidAt: true, orderId: true, order: { select: { orderNumber: true } } },
        orderBy: { paidAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.refund.findMany({
        where: { restaurantId, createdAt: within, ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}) },
        select: { id: true, amount: true, method: true, createdAt: true, orderId: true, order: { select: { orderNumber: true } } },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.goodsReceipt.findMany({
        where: { restaurantId, receivedAt: within, ...atBranch },
        select: {
          id: true, number: true, receivedAt: true, purchaseId: true,
          lines: { select: { acceptedQty: true, unitCost: true } },
        },
        orderBy: { receivedAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.supplierPayment.findMany({
        where: {
          restaurantId, paidAt: within,
          ...(branchIds ? { OR: [{ purchase: { branchId: { in: branchIds } } }, { purchaseId: null }] } : {}),
        },
        select: { id: true, amount: true, method: true, paidAt: true, supplier: { select: { name: true } }, supplierId: true },
        orderBy: { paidAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.purchaseReturn.findMany({
        where: { restaurantId, createdAt: within, ...atBranch },
        select: {
          id: true, number: true, createdAt: true,
          lines: { select: { quantity: true, unitCost: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.outgoingPayment.findMany({
        where: { restaurantId, kind: 'EXPENSE', status: 'PAID', paymentDate: within, ...atBranch },
        select: {
          id: true, number: true, amount: true, method: true, paymentDate: true,
          description: true, expenseCategory: { select: { name: true } },
        },
        orderBy: { paymentDate: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.pettyCashRequest.findMany({
        where: { restaurantId, status: 'PAID', paidAt: within, ...atBranch },
        select: { id: true, amount: true, paidAt: true, description: true },
        orderBy: { paidAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.wastageRecord.findMany({
        where: { restaurantId, createdAt: within, ...atBranch },
        select: { id: true, costValue: true, createdAt: true, reason: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.stockMovement.findMany({
        where: { restaurantId, type: { in: ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] }, createdAt: within },
        select: { id: true, type: true, quantity: true, unitCost: true, createdAt: true, item: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.stockMovement.findMany({
        where: { restaurantId, type: 'OPENING_BALANCE', createdAt: within },
        select: { id: true, quantity: true, unitCost: true, createdAt: true, item: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.cashMovement.findMany({
        where: {
          session: { restaurantId, ...atBranch },
          type: { in: ['CASH_OUT', 'CASH_PAID_OUT', 'BANK_DEPOSIT'] },
          createdAt: within,
        },
        select: { id: true, type: true, amount: true, createdAt: true, reason: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.cashDrawerSession.findMany({
        where: { restaurantId, status: { in: ['CLOSED', 'PENDING_REVIEW'] }, closedAt: within, ...atBranch },
        select: { id: true, sessionNumber: true, variance: true, closedAt: true },
        orderBy: { closedAt: 'desc' },
        take: MAX_ROWS,
      }),
    ])

  // J1 — the sale. Balances algebraically: grandTotal = subtotal − discounts
  // + tax + service + rounding, so receivable + discounts ≡ the credit side.
  for (const order of orders) {
    const discounts = order.discountTotal + order.loyaltyDiscount
    const made = entry({
      id: `sale:${order.id}`,
      date: order.placedAt,
      sourceType: 'SALE',
      sourceId: order.orderNumber,
      narrative: `Bill ${order.orderNumber}`,
      href: `/dashboard/orders/${order.id}`,
      lines: [
        { account: '1100', debit: order.grandTotal + order.tipAmount },
        { account: '4100', debit: discounts },
        { account: '4000', credit: order.subtotal },
        { account: '2100', credit: order.taxTotal },
        { account: '4900', credit: order.serviceCharge },
        { account: '2120', credit: order.tipAmount },
        {
          account: '4910',
          credit: order.roundingAdj > 0 ? order.roundingAdj : 0,
          debit: order.roundingAdj < 0 ? -order.roundingAdj : 0,
        },
      ],
    })
    if (made) entries.push(made)

    // J4 — the ingredients those sold lines consumed, at the cost pinned on
    // the line when it sold. Zero when nothing has a recipe behind it.
    const cogs = order.items.reduce((sum, item) => sum + Math.round(item.costPrice * item.quantity), 0)
    const cogsEntry = entry({
      id: `cogs:${order.id}`,
      date: order.placedAt,
      sourceType: 'COGS',
      sourceId: order.orderNumber,
      narrative: `Ingredients used by bill ${order.orderNumber}`,
      href: `/dashboard/orders/${order.id}`,
      lines: [
        { account: '5000', debit: cogs },
        { account: '1200', credit: cogs },
      ],
    })
    if (cogsEntry) entries.push(cogsEntry)
  }

  // J2 — settlement: the receivable turns into money.
  for (const payment of payments) {
    const made = entry({
      id: `settle:${payment.id}`,
      date: payment.paidAt ?? range.from,
      sourceType: 'SETTLEMENT',
      sourceId: payment.order?.orderNumber ?? payment.id,
      narrative: `Payment received — ${payment.method.toLowerCase().replace(/_/g, ' ')}`,
      href: `/dashboard/orders/${payment.orderId}`,
      lines: [
        { account: accountForMethod(payment.method), debit: payment.amount, dimension: payment.method },
        { account: '1100', credit: payment.amount },
      ],
    })
    if (made) entries.push(made)
  }

  // J3 — a refund: money back out, revenue reduced through its contra.
  for (const refund of refunds) {
    const made = entry({
      id: `refund:${refund.id}`,
      date: refund.createdAt,
      sourceType: 'REFUND',
      sourceId: refund.order?.orderNumber ?? refund.id,
      narrative: `Refund on bill ${refund.order?.orderNumber ?? ''}`.trim(),
      href: `/dashboard/orders/${refund.orderId}`,
      lines: [
        { account: '4110', debit: refund.amount },
        { account: accountForMethod(refund.method), credit: refund.amount, dimension: refund.method },
      ],
    })
    if (made) entries.push(made)
  }

  // J5 — goods received: stock arrives, the supplier is owed.
  for (const receipt of receipts) {
    const value = receipt.lines.reduce((sum, line) => sum + Math.round(line.acceptedQty * line.unitCost), 0)
    const made = entry({
      id: `grn:${receipt.id}`,
      date: receipt.receivedAt,
      sourceType: 'GOODS RECEIVED',
      sourceId: receipt.number,
      narrative: `Goods received ${receipt.number}`,
      href: receipt.purchaseId ? `/dashboard/purchases/${receipt.purchaseId}` : '/dashboard/purchases',
      lines: [
        { account: '1200', debit: value },
        { account: '2000', credit: value },
      ],
    })
    if (made) entries.push(made)
  }

  // J6 — paying a supplier. Negative amounts are reversal rows and flip
  // naturally: the debit becomes a credit and the payable comes back.
  for (const payment of supplierPayments) {
    const made = entry({
      id: `supplierpay:${payment.id}`,
      date: payment.paidAt,
      sourceType: 'SUPPLIER PAYMENT',
      sourceId: payment.supplier?.name ?? payment.supplierId,
      narrative: `Paid ${payment.supplier?.name ?? 'supplier'}`,
      href: `/dashboard/suppliers/${payment.supplierId}`,
      lines: [
        {
          account: '2000',
          debit: payment.amount > 0 ? payment.amount : 0,
          credit: payment.amount < 0 ? -payment.amount : 0,
        },
        {
          account: accountForMethod(payment.method),
          credit: payment.amount > 0 ? payment.amount : 0,
          debit: payment.amount < 0 ? -payment.amount : 0,
          dimension: payment.method,
        },
      ],
    })
    if (made) entries.push(made)
  }

  // J7 — goods sent back: the payable falls with the stock.
  for (const ret of returns) {
    const value = ret.lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCost), 0)
    const made = entry({
      id: `return:${ret.id}`,
      date: ret.createdAt,
      sourceType: 'PURCHASE RETURN',
      sourceId: ret.number,
      narrative: `Returned to supplier ${ret.number}`,
      href: '/dashboard/purchases',
      lines: [
        { account: '2000', debit: value },
        { account: '1200', credit: value },
      ],
    })
    if (made) entries.push(made)
  }

  // J8 — an approved expense, paid.
  for (const payment of outgoing) {
    const made = entry({
      id: `expense:${payment.id}`,
      date: payment.paymentDate,
      sourceType: 'EXPENSE',
      sourceId: payment.number,
      narrative: payment.description,
      href: '/dashboard/accounting/payments',
      lines: [
        { account: '6000', debit: payment.amount, dimension: payment.expenseCategory?.name ?? 'Uncategorised' },
        { account: accountForMethod(payment.method), credit: payment.amount, dimension: payment.method },
      ],
    })
    if (made) entries.push(made)
  }

  // J9 — petty cash paid out of the tin.
  for (const request of petty) {
    const made = entry({
      id: `petty:${request.id}`,
      date: request.paidAt ?? range.from,
      sourceType: 'PETTY CASH',
      sourceId: request.id.slice(0, 8),
      narrative: request.description,
      href: '/dashboard/petty-cash',
      lines: [
        { account: '6100', debit: request.amount },
        { account: '1000', credit: request.amount },
      ],
    })
    if (made) entries.push(made)
  }

  // J10 — wastage, at what the wasted stock cost.
  for (const record of wastage) {
    const made = entry({
      id: `waste:${record.id}`,
      date: record.createdAt,
      sourceType: 'WASTAGE',
      sourceId: record.id.slice(0, 8),
      narrative: `Wastage — ${record.reason.toLowerCase().replace(/_/g, ' ')}`,
      href: '/dashboard/inventory/wastage',
      lines: [
        { account: '6200', debit: record.costValue },
        { account: '1200', credit: record.costValue },
      ],
    })
    if (made) entries.push(made)
  }

  // J11 — a counted stock adjustment, valued at the item's cost.
  for (const movement of adjustments) {
    const value = Math.round(Math.abs(movement.quantity) * movement.unitCost)
    const isIn = movement.type === 'ADJUSTMENT_IN'
    const made = entry({
      id: `adjust:${movement.id}`,
      date: movement.createdAt,
      sourceType: 'STOCK ADJUSTMENT',
      sourceId: movement.item?.name ?? movement.id.slice(0, 8),
      narrative: `${isIn ? 'Stock found' : 'Stock written off'} — ${movement.item?.name ?? ''}`.trim(),
      href: '/dashboard/inventory/ledger',
      lines: isIn
        ? [
            { account: '1200', debit: value },
            { account: '6210', credit: value },
          ]
        : [
            { account: '6210', debit: value },
            { account: '1200', credit: value },
          ],
    })
    if (made) entries.push(made)
  }

  // J12 — opening stock: what was on the shelves before the books began.
  for (const movement of openings) {
    const value = Math.round(Math.abs(movement.quantity) * movement.unitCost)
    const made = entry({
      id: `opening:${movement.id}`,
      date: movement.createdAt,
      sourceType: 'OPENING STOCK',
      sourceId: movement.item?.name ?? movement.id.slice(0, 8),
      narrative: `Opening stock — ${movement.item?.name ?? ''}`.trim(),
      href: '/dashboard/inventory/ledger',
      lines: [
        { account: '1200', debit: value },
        { account: '3000', credit: value },
      ],
    })
    if (made) entries.push(made)
  }

  // J14–J15 — cash paid out, and cash taken to the bank.
  for (const movement of cashMovements) {
    const isDeposit = movement.type === 'BANK_DEPOSIT'
    const made = entry({
      id: `cash:${movement.id}`,
      date: movement.createdAt,
      sourceType: 'CASH MOVEMENT',
      sourceId: movement.type,
      narrative: movement.reason,
      href: '/dashboard/cash-drawer',
      lines: isDeposit
        ? [
            { account: '1050', debit: movement.amount },
            { account: '1000', credit: movement.amount },
          ]
        : [
            { account: '6900', debit: movement.amount },
            { account: '1000', credit: movement.amount },
          ],
    })
    if (made) entries.push(made)
  }

  // J16 — a counted drawer difference, on the books where it belongs.
  for (const session of drawers) {
    if (!session.variance) continue
    const short = session.variance < 0
    const value = Math.abs(session.variance)
    const made = entry({
      id: `variance:${session.id}`,
      date: session.closedAt ?? range.to,
      sourceType: 'CASH DIFFERENCE',
      sourceId: session.sessionNumber,
      narrative: `Drawer ${session.sessionNumber} counted ${short ? 'short' : 'over'}`,
      href: `/dashboard/cash-drawer/${session.id}`,
      lines: short
        ? [
            { account: '6910', debit: value },
            { account: '1000', credit: value },
          ]
        : [
            { account: '1000', debit: value },
            { account: '6910', credit: value },
          ],
    })
    if (made) entries.push(made)
  }

  entries.sort((a, b) => b.date.getTime() - a.date.getTime() || a.sourceType.localeCompare(b.sourceType))
  return entries
}
