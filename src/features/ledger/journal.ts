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
 *   • `PaymentAccountEntry` — deposits into, and transfers between, the
 *     owner's internal accounts (bank.md). Those accounts are a private record
 *     of where money is considered to sit; this journal already books the same
 *     money into 1000/1050 from the PAYMENT that earned it, so projecting the
 *     account movement as well would count it twice. The two figures are also
 *     not comparable: an internal account opens at zero and only counts what
 *     has happened since, while 1000/1050 replay the whole history.
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
  /**
   * Set when the source did not balance and the gap was plugged into 4910.
   * A plug keeps the trial balance foldable; the warning is what stops it
   * hiding a real defect — it hid a year of tax-inclusive sales crediting
   * revenue gross of tax.
   */
  warning?: string
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
  let warning: string | undefined
  if (debits !== credits) {
    warning = `Source is unbalanced: debits ${debits} ≠ credits ${credits}; the gap of ${debits - credits} was plugged into 4910`
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
    warning,
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

/**
 * What a stock movement did to the inventory account, in minor units.
 *
 * ── Why not quantity × unitCost ─────────────────────────────────────────────
 *
 * Because that is a reconstruction, and it does not reconstruct. `unitCost` is
 * a per-unit figure rounded to whole minor units for display; the FIFO
 * allocator records the exact figure in `valueMoved`, and the two disagree
 * twice over:
 *
 *   · rounding — 650 paid for 1,000 g is 0.65 a gram, which stores as 1 and
 *     multiplies back to 1,000. The journal booked a 54% overstatement into
 *     account 1200 and the trial balance still balanced, because both legs
 *     were built from the same wrong number;
 *   · layer spans — a draw crossing two layers has no single unit cost at all,
 *     so no multiplication can recover what it took.
 *
 * `valueMoved` is the sum of the layer draws the movement actually made, so
 * posting it means account 1200's movement equals the change in the sum of the
 * layers, exactly. That tie is the whole reason the balance sheet can be
 * trusted against the stock screens, and it is checked in `ledger-test`.
 *
 * The fallback is for movements written before `valueMoved` existed — the
 * migration backfilled them, but a zero on a real quantity would silently
 * drop stock out of the books, and the old reconstruction is a better answer
 * than none.
 */
function stockValueOf(movement: {
  quantity: number
  unitCost: number
  valueMoved: number
}): number {
  if (movement.valueMoved !== 0) return Math.abs(Math.round(movement.valueMoved))
  return Math.round(Math.abs(movement.quantity) * movement.unitCost)
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
          roundingAdj: true, grandTotal: true, taxInclusive: true,
          // The lines themselves are no longer read: COGS comes from the stock
          // the order actually consumed, not from the cost pinned on the line.
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
        select: { id: true, type: true, quantity: true, unitCost: true, valueMoved: true, createdAt: true, item: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      prisma.stockMovement.findMany({
        where: { restaurantId, type: 'OPENING_BALANCE', createdAt: within },
        select: { id: true, quantity: true, unitCost: true, valueMoved: true, createdAt: true, item: { select: { name: true } } },
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

  /*
   * What each bill's ingredients actually cost the inventory (FIFO.md).
   *
   * ── Why not the cost pinned on the line ─────────────────────────────────────
   *
   * Because `OrderItem.costPrice` is two different things wearing one name, and
   * only one of them is a transaction:
   *
   *   · on a line WITH a recipe it is the resolved ingredient cost, and the
   *     stock really does leave — measured against the layers on live data,
   *     the two agreed to the minor unit;
   *   · on a line with NO recipe it is `Food.costPrice`, a figure typed into
   *     the menu dialog. Nothing leaves stock, because there is no recipe
   *     saying what would.
   *
   * The second was being credited to Inventory anyway. On this database that
   * was 18,826,500 across 889 lines against 15,600 of stock that actually
   * moved — the inventory account being written down by a thousand times what
   * left the shelves, every figure still balancing, because both legs of the
   * entry were built from the same invented number.
   *
   * And it double-counted: a bought-in cake was already expensed when it was
   * bought, through the goods receipt (J5) or the expense payment (J8).
   * Booking the menu card's guess as a second expense charges the restaurant
   * twice for one cake.
   *
   * So J4 posts what the ledger did: the value the FIFO allocator took off the
   * layers for this order, net of anything a cancelled line put back. The
   * estimate still has a home — the profit report uses it for per-dish margin,
   * which is a management question, not a posting. This is the tie that lets
   * account 1200 be checked against the stock screens at all.
   */
  const consumedByOrder = new Map<string, number>()
  if (orders.length > 0) {
    const consumed = await prisma.stockMovement.groupBy({
      by: ['orderId', 'type'],
      where: {
        restaurantId,
        orderId: { in: orders.map((o) => o.id) },
        type: { in: ['SALE', 'SALE_REVERSAL'] },
      },
      _sum: { valueMoved: true },
    })
    for (const row of consumed) {
      if (!row.orderId) continue
      // `valueMoved` is a magnitude; the type says the direction. A reversal
      // put stock back, so it reduces what this bill consumed.
      const signed = (row.type === 'SALE_REVERSAL' ? -1 : 1) * Math.abs(row._sum.valueMoved ?? 0)
      consumedByOrder.set(row.orderId, (consumedByOrder.get(row.orderId) ?? 0) + signed)
    }
  }

  /*
   * What the returned stock was actually carrying, per return.
   *
   * A movement names its return through `referenceType`/`referenceId` rather
   * than a foreign key, so this cannot be an `include` on the query above.
   */
  const returnedValue = new Map<string, number>()
  if (returns.length > 0) {
    const moved = await prisma.stockMovement.groupBy({
      by: ['referenceId'],
      where: {
        restaurantId,
        referenceType: 'PurchaseReturn',
        referenceId: { in: returns.map((r) => r.id) },
      },
      _sum: { valueMoved: true },
    })
    for (const row of moved) {
      if (row.referenceId) {
        returnedValue.set(row.referenceId, Math.abs(Math.round(row._sum.valueMoved ?? 0)))
      }
    }
  }

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
        /*
         * Revenue is what the guest paid for the food, without the tax. On a
         * tax-inclusive bill the subtotal already CONTAINS the tax that the
         * 2100 line below records as a liability; crediting both in full
         * double-counted it, and `entry()` quietly plugged the difference —
         * about a tax rate's worth of every inclusive sale — into "rounding".
         */
        { account: '4000', credit: order.subtotal - (order.taxInclusive ? order.taxTotal : 0) },
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

    // J4 — the ingredients those sold lines consumed, at what the FIFO layers
    // gave up for them. Zero when nothing has a recipe behind it, because then
    // nothing left the store — see `consumedByOrder` above.
    const cogs = Math.max(0, Math.round(consumedByOrder.get(order.id) ?? 0))
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

  /*
   * J7 — goods sent back: the payable falls with the stock.
   *
   * Two different figures, which is why this entry has three legs where it
   * used to have two:
   *
   *   · what the SUPPLIER credits — the invoice price on the return note, and
   *     the only thing that may reduce the payable;
   *   · what the STOCK was carrying — the layers the goods actually came off,
   *     and the only thing that may reduce inventory.
   *
   * Both were posted at the first figure, so returning goods silently rewrote
   * the inventory account to whatever the supplier happened to credit. They
   * agree whenever the return names its purchase, because the allocator takes
   * the goods back off the layers that delivery created; they part company on
   * a return with no purchase behind it, which falls through to ordinary FIFO
   * and can send back stock that came in at another price. That difference is
   * a gain or loss on the stock, and it belongs in 6210 with the other stock
   * differences rather than hidden inside the payable.
   */
  for (const ret of returns) {
    const credited = ret.lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCost), 0)
    const stock = returnedValue.get(ret.id) ?? credited
    const difference = credited - stock
    const made = entry({
      id: `return:${ret.id}`,
      date: ret.createdAt,
      sourceType: 'PURCHASE RETURN',
      sourceId: ret.number,
      narrative: `Returned to supplier ${ret.number}`,
      href: '/dashboard/purchases',
      lines: [
        { account: '2000', debit: credited },
        { account: '1200', credit: stock },
        // Credited for more than the stock was carrying is a gain, and less a
        // loss. Zero on an ordinary return, so the leg simply does not appear.
        { account: '6210', credit: difference > 0 ? difference : 0, debit: difference < 0 ? -difference : 0 },
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

  // J11 — a counted stock adjustment, at exactly what the layers moved by.
  for (const movement of adjustments) {
    const value = stockValueOf(movement)
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
    const value = stockValueOf(movement)
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
