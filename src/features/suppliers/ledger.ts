import 'server-only'

import { NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * What a supplier is owed, and how we got there.
 *
 * ── The balance is derived, never stored ────────────────────────────────────
 *
 * There is no `balance` column on `Supplier` and there will not be one. The
 * figure is recomputed from the documents on every read:
 *
 *     owed  =  value received  −  payments  −  returns
 *
 * A stored balance is a second source of truth. It drifts the first time a
 * receipt is posted by a path that forgets to update it, and then no report in
 * the system can be trusted — which is the bug class that has cost this project
 * more time than any other. Recomputing costs one indexed query per document
 * type and cannot be wrong.
 *
 * ── Received, not ordered ───────────────────────────────────────────────────
 *
 * A purchase order is a promise; nobody owes anything for goods that have not
 * arrived. So the debt is the value of what was actually RECEIVED — accepted
 * quantity times the price actually charged, from the goods receipt lines.
 * Rejected quantities never enter, because nobody pays for what they sent back
 * on the van.
 *
 * That distinction matters in practice: an owner with 400,000 of open orders
 * and 50,000 delivered owes 50,000, and a system that reported 400,000 would
 * have them chasing money they do not yet owe.
 *
 * ── Signs ───────────────────────────────────────────────────────────────────
 *
 * A supplier account is a liability, so it is kept the way a supplier's own
 * statement reads: a delivery CREDITS the account (we owe more), a payment or
 * a return DEBITS it (we owe less). Balance is what is outstanding, and a
 * negative balance means they are in credit — usually an overpayment or a
 * return after settling.
 */

export type LedgerKind = 'OPENING' | 'RECEIPT' | 'PAYMENT' | 'RETURN'

export interface LedgerEntry {
  id: string
  kind: LedgerKind
  date: string
  reference: string
  description: string
  /** Reduces what we owe. */
  debit: number
  /** Increases what we owe. */
  credit: number
  /** Running total after this row. */
  balance: number
  /** Where the reference points, so a statement can be read backwards. */
  href: string | null
}

export interface SupplierLedger {
  supplier: {
    id: string
    name: string
    company: string | null
    contactName: string | null
    phone: string | null
    email: string | null
    address: string | null
    taxNumber: string | null
    paymentTerms: string
    paymentTermsNote: string | null
    notes: string | null
    isActive: boolean
    createdAt: string
  }
  entries: LedgerEntry[]
  totals: {
    received: number
    paid: number
    returned: number
    /** received − paid − returned. Positive means we owe them. */
    outstanding: number
    /** Value on orders raised but not yet delivered — owed to nobody yet. */
    onOrder: number
  }
  purchases: Array<{
    id: string
    number: string
    status: string
    branchName: string | null
    createdAt: string
    expectedAt: string | null
    total: number
    receivedValue: number
    lineCount: number
    receiptCount: number
  }>
  payments: Array<{
    id: string
    amount: number
    method: string
    reference: string | null
    notes: string | null
    paidAt: string
    createdByName: string
    purchaseId: string | null
    purchaseNumber: string | null
  }>
  receipts: Array<{
    id: string
    number: string
    purchaseId: string
    purchaseNumber: string
    branchName: string | null
    supplierRef: string | null
    receivedAt: string
    value: number
    lineCount: number
  }>
}

export async function getSupplierLedger(params: {
  restaurantId: string
  supplierId: string
  /**
   * Which locations the reader may see. `null` is unrestricted; `[]` is
   * confined with nowhere to look and correctly matches nothing.
   *
   * ── Why the ledger is scoped and the supplier is not ──────────────────────
   *
   * A supplier record belongs to the business — one list, shared, and the
   * purchasing screens depend on that. The *transactions* hanging off it do
   * not: a purchase order, a delivery and a return each happened at one
   * location, and three of those four models carry a `branchId` already.
   *
   * These four queries had no branch predicate at all, and the page renders
   * `branch.name` beside every row. `SUPPLIER_VIEW` is held by WAREHOUSE_STAFF
   * — always confined to one site — and by assigned MANAGERs, so a Kandy
   * warehouse worker opening a supplier read every branch's orders, receipts,
   * returns and the amount owed, neatly labelled by branch.
   */
  branchIds?: string[] | null
}): Promise<SupplierLedger> {
  const supplier = await prisma.supplier.findFirst({
    where: { id: params.supplierId, restaurantId: params.restaurantId },
  })
  if (!supplier) throw new NotFoundError('Supplier')

  const reach = params.branchIds ?? null
  /** For the three models that carry a branch of their own. */
  const atBranch = reach ? { branchId: { in: reach } } : {}
  /*
   * A payment reaches a location through the order it settles — the same
   * one-hop rule `Payment` and `ServiceRequest` already use. A payment on
   * account carries no purchase, so it stays visible: money handed to a
   * supplier with no order against it is a business-level fact, and hiding it
   * would make the running balance stop adding up.
   */
  const paymentScope = reach
    ? { OR: [{ purchase: { branchId: { in: reach } } }, { purchaseId: null }] }
    : {}

  const [purchases, receipts, payments, returns] = await Promise.all([
    prisma.purchase.findMany({
      where: {
        restaurantId: params.restaurantId,
        supplierId: supplier.id,
        status: { notIn: ['CANCELLED'] },
        ...atBranch,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        items: { select: { quantity: true, unitCost: true } },
        receipts: {
          select: { id: true, lines: { select: { acceptedQty: true, unitCost: true } } },
        },
      },
    }),
    prisma.goodsReceipt.findMany({
      where: {
        restaurantId: params.restaurantId,
        purchase: { supplierId: supplier.id },
        ...atBranch,
      },
      orderBy: { receivedAt: 'asc' },
      include: {
        branch: { select: { name: true } },
        purchase: { select: { id: true, number: true, branch: { select: { name: true } } } },
        lines: { select: { acceptedQty: true, unitCost: true } },
      },
    }),
    prisma.supplierPayment.findMany({
      where: {
        restaurantId: params.restaurantId,
        supplierId: supplier.id,
        ...paymentScope,
      },
      orderBy: { paidAt: 'asc' },
      include: { purchase: { select: { id: true, number: true } } },
    }),
    prisma.purchaseReturn.findMany({
      where: {
        restaurantId: params.restaurantId,
        supplierId: supplier.id,
        ...atBranch,
      },
      orderBy: { createdAt: 'asc' },
      include: { lines: { select: { quantity: true, unitCost: true } } },
    }),
  ])

  const receiptValue = (lines: Array<{ acceptedQty: number; unitCost: number }>) =>
    lines.reduce((sum, l) => sum + Math.round(l.acceptedQty * l.unitCost), 0)

  /*
   * One list, in date order, then walked once to produce the running balance.
   *
   * Sorting before accumulating is the whole trick: a balance computed per
   * source and added up would be right in total and wrong on every line, and a
   * statement whose middle rows do not add up is worse than no statement.
   */
  const rows: Array<Omit<LedgerEntry, 'balance'>> = []

  for (const receipt of receipts) {
    const value = receiptValue(receipt.lines)
    if (value === 0) continue
    rows.push({
      id: `receipt-${receipt.id}`,
      kind: 'RECEIPT',
      date: receipt.receivedAt.toISOString(),
      reference: receipt.number,
      description: [
        `Goods received on ${receipt.purchase.number}`,
        receipt.branch?.name ?? receipt.purchase.branch?.name,
        receipt.supplierRef && `their invoice ${receipt.supplierRef}`,
      ]
        .filter(Boolean)
        .join(' · '),
      debit: 0,
      credit: value,
      href: `/dashboard/purchases/${receipt.purchase.id}/receipts/${receipt.id}`,
    })
  }

  for (const payment of payments) {
    rows.push({
      id: `payment-${payment.id}`,
      kind: 'PAYMENT',
      date: payment.paidAt.toISOString(),
      reference: payment.reference || payment.method.replace(/_/g, ' ').toLowerCase(),
      description: [
        payment.purchase ? `Payment against ${payment.purchase.number}` : 'Payment on account',
        payment.notes,
      ]
        .filter(Boolean)
        .join(' · '),
      debit: payment.amount,
      credit: 0,
      href: payment.purchase ? `/dashboard/purchases/${payment.purchase.id}` : null,
    })
  }

  for (const ret of returns) {
    const value = ret.lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitCost), 0)
    if (value === 0) continue
    rows.push({
      id: `return-${ret.id}`,
      kind: 'RETURN',
      date: ret.createdAt.toISOString(),
      reference: ret.number,
      description: `Returned to supplier — ${ret.reason}`,
      debit: value,
      credit: 0,
      href: ret.purchaseId ? `/dashboard/purchases/${ret.purchaseId}` : null,
    })
  }

  rows.sort((a, b) => a.date.localeCompare(b.date))

  let balance = 0
  const entries: LedgerEntry[] = [
    /*
     * An explicit opening row at zero. There is no opening-balance feature and
     * nothing was migrated in, so every account genuinely starts at nil — and
     * saying so beats a statement that begins mid-air with an unexplained
     * first figure.
     */
    {
      id: 'opening',
      kind: 'OPENING',
      date: supplier.createdAt.toISOString(),
      reference: 'Opening balance',
      description: 'Nothing owed at the start',
      debit: 0,
      credit: 0,
      balance: 0,
      href: null,
    },
    ...rows.map((row) => {
      balance += row.credit - row.debit
      return { ...row, balance }
    }),
  ]

  const received = rows.filter((r) => r.kind === 'RECEIPT').reduce((s, r) => s + r.credit, 0)
  const paid = rows.filter((r) => r.kind === 'PAYMENT').reduce((s, r) => s + r.debit, 0)
  const returned = rows.filter((r) => r.kind === 'RETURN').reduce((s, r) => s + r.debit, 0)

  /*
   * What has been ordered and not yet delivered. Reported separately and never
   * folded into the balance: nobody owes for goods still on a van, and mixing
   * the two would have an owner chasing money they do not yet owe.
   */
  const onOrder = purchases.reduce((sum, po) => {
    const ordered = po.items.reduce((s, l) => s + Math.round(l.quantity * l.unitCost), 0)
    const delivered = po.receipts.reduce((s, r) => s + receiptValue(r.lines), 0)
    return sum + Math.max(0, ordered - delivered)
  }, 0)

  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
      company: supplier.company,
      contactName: supplier.contactName,
      phone: supplier.phone,
      email: supplier.email,
      address: supplier.address,
      taxNumber: supplier.taxNumber,
      paymentTerms: supplier.paymentTerms,
      paymentTermsNote: supplier.paymentTermsNote,
      notes: supplier.notes,
      isActive: supplier.isActive,
      createdAt: supplier.createdAt.toISOString(),
    },
    entries,
    totals: { received, paid, returned, outstanding: received - paid - returned, onOrder },
    purchases: purchases.map((po) => ({
      id: po.id,
      number: po.number,
      status: po.status as string,
      branchName: po.branch?.name ?? null,
      createdAt: po.createdAt.toISOString(),
      expectedAt: po.expectedAt?.toISOString() ?? null,
      total: po.total,
      receivedValue: po.receipts.reduce((s, r) => s + receiptValue(r.lines), 0),
      lineCount: po.items.length,
      receiptCount: po.receipts.length,
    })),
    payments: payments
      .slice()
      .reverse()
      .map((p) => ({
        id: p.id,
        amount: p.amount,
        method: p.method as string,
        reference: p.reference,
        notes: p.notes,
        paidAt: p.paidAt.toISOString(),
        createdByName: p.createdByName,
        purchaseId: p.purchase?.id ?? null,
        purchaseNumber: p.purchase?.number ?? null,
      })),
    receipts: receipts
      .slice()
      .reverse()
      .map((r) => ({
        id: r.id,
        number: r.number,
        purchaseId: r.purchase.id,
        purchaseNumber: r.purchase.number,
        branchName: r.branch?.name ?? r.purchase.branch?.name ?? null,
        supplierRef: r.supplierRef,
        receivedAt: r.receivedAt.toISOString(),
        value: receiptValue(r.lines),
        lineCount: r.lines.length,
      })),
  }
}

/**
 * Outstanding balances for the whole supplier list.
 *
 * Computed in three grouped queries rather than per supplier, because the list
 * page would otherwise fire one ledger read per row.
 */
export async function getSupplierBalances(
  restaurantId: string,
  /** Same rule as the ledger: `null` unrestricted, `[]` nothing. */
  branchIds?: string[] | null,
): Promise<Map<string, number>> {
  const reach = branchIds ?? null
  const atBranch = reach ? { branchId: { in: reach } } : {}
  const paymentScope = reach
    ? { OR: [{ purchase: { branchId: { in: reach } } }, { purchaseId: null }] }
    : {}

  const [receipts, payments, returns] = await Promise.all([
    prisma.goodsReceiptLine.findMany({
      where: {
        receipt: { restaurantId, purchase: { supplierId: { not: null } }, ...atBranch },
      },
      select: {
        acceptedQty: true,
        unitCost: true,
        receipt: { select: { purchase: { select: { supplierId: true } } } },
      },
    }),
    prisma.supplierPayment.groupBy({
      by: ['supplierId'],
      where: { restaurantId, ...paymentScope },
      _sum: { amount: true },
    }),
    prisma.purchaseReturnLine.findMany({
      where: { return: { restaurantId, supplierId: { not: null }, ...atBranch } },
      select: { quantity: true, unitCost: true, return: { select: { supplierId: true } } },
    }),
  ])

  const balances = new Map<string, number>()
  const add = (supplierId: string | null | undefined, amount: number) => {
    if (!supplierId) return
    balances.set(supplierId, (balances.get(supplierId) ?? 0) + amount)
  }

  for (const line of receipts) {
    add(line.receipt.purchase.supplierId, Math.round(line.acceptedQty * line.unitCost))
  }
  for (const row of payments) {
    add(row.supplierId, -(row._sum.amount ?? 0))
  }
  for (const line of returns) {
    add(line.return.supplierId, -Math.round(line.quantity * line.unitCost))
  }

  return balances
}
