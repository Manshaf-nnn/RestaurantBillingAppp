import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * The data integrity checker (§115–116).
 *
 * Every check is a question the database should never answer "yes" to, asked
 * in SQL against the live rows. Each returns OK, WARNING or ERROR with the
 * number of offenders and a handful of identifiers to start from — a manager
 * reads the statuses, an engineer reads the examples.
 *
 * WARNING marks states that can be legitimate but deserve eyes (negative
 * stock where the restaurant allows it, an unpaid invoice growing old).
 * ERROR marks arithmetic that has actually broken: money or stock that no
 * longer explains itself.
 */

export type IntegrityStatus = 'OK' | 'WARNING' | 'ERROR'

export interface IntegrityCheck {
  key: string
  label: string
  status: IntegrityStatus
  /** How many rows offend. */
  count: number
  /** Up to five identifiers to start an investigation from. */
  examples: string[]
  detail: string
}

export interface IntegrityReport {
  ranAt: string
  status: IntegrityStatus
  checks: IntegrityCheck[]
}

const EXAMPLE_LIMIT = 5

export async function runIntegrityChecks(restaurantId: string): Promise<IntegrityReport> {
  const checks: IntegrityCheck[] = []

  const add = (
    key: string,
    label: string,
    severity: Exclude<IntegrityStatus, 'OK'>,
    detail: string,
    rows: Array<{ id: string | null }>,
  ) => {
    checks.push({
      key,
      label,
      status: rows.length === 0 ? 'OK' : severity,
      count: rows.length,
      examples: rows.slice(0, EXAMPLE_LIMIT).map((row) => row.id ?? '?'),
      detail,
    })
  }

  // ── Money ──────────────────────────────────────────────────────────────────

  add(
    'order-line-sum',
    'Order totals match their lines',
    'ERROR',
    'sum(active lineTotal) must equal the order subtotal — the guest-edit class of bug.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT o.id FROM orders o
      WHERE o."restaurantId" = ${restaurantId}
        AND o.status <> 'CANCELLED'
        AND o.subtotal <> COALESCE((
          SELECT SUM(oi."lineTotal") FROM order_items oi
          WHERE oi."orderId" = o.id AND oi.status <> 'CANCELLED'
        ), 0)
      LIMIT 200
    `,
  )

  add(
    'discount-split',
    'Discount columns sum to the total',
    'ERROR',
    'discountTotal must equal couponDiscount + manualDiscount.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM orders
      WHERE "restaurantId" = ${restaurantId}
        AND "discountTotal" <> "couponDiscount" + "manualDiscount"
      LIMIT 200
    `,
  )

  add(
    'paid-total',
    'Paid totals match the payment ledger',
    'ERROR',
    'paidTotal must equal settled payments minus refunds — the double-settle / double-refund class.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT o.id FROM orders o
      WHERE o."restaurantId" = ${restaurantId}
        AND o."paidTotal" <> GREATEST(0,
          COALESCE((SELECT SUM(p.amount) FROM payments p
            WHERE p."orderId" = o.id AND p.status IN ('PAID','REFUNDED')), 0)
          - COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r."orderId" = o.id), 0))
      LIMIT 200
    `,
  )

  add(
    'refund-excess',
    'No payment refunded beyond its amount',
    'ERROR',
    'The refunds against one payment must never exceed what that payment took.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM payments p
      WHERE p."restaurantId" = ${restaurantId}
        AND COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r."paymentId" = p.id), 0) > p.amount
      LIMIT 200
    `,
  )

  add(
    'duplicate-invoice-number',
    'Invoice numbers are unique',
    'ERROR',
    'Two invoices sharing a number is the failure the counter exists to prevent.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT MIN(number) AS id FROM invoices
      WHERE "restaurantId" = ${restaurantId}
      GROUP BY number HAVING COUNT(*) > 1
      LIMIT 200
    `,
  )

  add(
    'duplicate-order-number',
    'Order numbers are unique',
    'ERROR',
    'Order numbers are the join key on every printed document.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT MIN("orderNumber") AS id FROM orders
      WHERE "restaurantId" = ${restaurantId}
      GROUP BY "orderNumber" HAVING COUNT(*) > 1
      LIMIT 200
    `,
  )

  add(
    'paid-without-invoice',
    'Settled orders carry an invoice',
    'WARNING',
    'A fully settled order should have been invoiced at settlement if not at presentation.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT o.id FROM orders o
      LEFT JOIN invoices i ON i."orderId" = o.id
      WHERE o."restaurantId" = ${restaurantId}
        AND o."paymentStatus" = 'PAID'
        AND i.id IS NULL
      LIMIT 200
    `,
  )

  // ── Loyalty ────────────────────────────────────────────────────────────────

  add(
    'loyalty-ledger',
    'Loyalty balances equal their ledgers',
    'ERROR',
    'Every balance must be the sum of its entries (§72).',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM customers c
      WHERE c."restaurantId" = ${restaurantId}
        AND c."loyaltyPoints" <> COALESCE((
          SELECT SUM(e.points) FROM loyalty_entries e WHERE e."customerId" = c.id
        ), 0)
      LIMIT 200
    `,
  )

  // ── Stock ──────────────────────────────────────────────────────────────────

  add(
    'stock-replay',
    'Stock balances match their movements',
    'ERROR',
    'item.quantity must equal the sum of its ledger — a balance changed off-ledger otherwise.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT i.id FROM inventory_items i
      WHERE i."restaurantId" = ${restaurantId}
        AND ABS(i.quantity - COALESCE((
          SELECT SUM(m.quantity) FROM stock_movements m WHERE m."itemId" = i.id
        ), 0)) > 1e-6
      LIMIT 200
    `,
  )

  add(
    'branch-stock-sum',
    'Branch shelves sum to the item totals',
    'ERROR',
    'The per-branch rows must add up to the restaurant-wide balance.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT i.id FROM inventory_items i
      WHERE i."restaurantId" = ${restaurantId}
        AND EXISTS (SELECT 1 FROM inventory_stock s WHERE s."itemId" = i.id)
        AND ABS(i.quantity - COALESCE((
          SELECT SUM(s.available) FROM inventory_stock s WHERE s."itemId" = i.id
        ), 0)) > 1e-6
      LIMIT 200
    `,
  )

  add(
    'negative-stock',
    'No balance below zero',
    'WARNING',
    'Legitimate only where the restaurant has allowed negative stock; always worth eyes.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM inventory_items
      WHERE "restaurantId" = ${restaurantId} AND quantity < 0
      LIMIT 200
    `,
  )

  add(
    'consumption-without-order',
    'Every sale movement names its order',
    'ERROR',
    'A SALE row with no surviving order is consumption nothing can explain.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT m.id FROM stock_movements m
      LEFT JOIN orders o ON o.id = m."orderId"
      WHERE m."restaurantId" = ${restaurantId}
        AND m.type IN ('SALE', 'SALE_REVERSAL')
        AND (m."orderId" IS NULL OR o.id IS NULL)
      LIMIT 200
    `,
  )

  add(
    'depletion-without-order',
    'Depletion records belong to live orders',
    'ERROR',
    'An order_stock_depletions row whose order is gone will corrupt the next reconcile.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT d.id FROM order_stock_depletions d
      LEFT JOIN orders o ON o.id = d."orderId"
      WHERE d."restaurantId" = ${restaurantId} AND o.id IS NULL
      LIMIT 200
    `,
  )

  // ── Tenancy ────────────────────────────────────────────────────────────────

  add(
    'tenant-mismatch',
    'Payments belong to their order’s restaurant',
    'ERROR',
    'A payment whose restaurantId differs from its order’s is a tenancy break.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM payments p
      JOIN orders o ON o.id = p."orderId"
      WHERE p."restaurantId" = ${restaurantId}
        AND o."restaurantId" <> p."restaurantId"
      LIMIT 200
    `,
  )

  // ── The money-out workflow ─────────────────────────────────────────────────

  add(
    'outgoing-paid-link',
    'Paid supplier payments reached the ledger',
    'ERROR',
    'A PAID supplier payment must hold the SupplierPayment row it projected — without it the supplier balance and the workflow disagree.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT number AS id FROM outgoing_payments
      WHERE "restaurantId" = ${restaurantId}
        AND kind = 'SUPPLIER' AND status = 'PAID'
        AND "supplierPaymentId" IS NULL
      LIMIT 200
    `,
  )

  add(
    'outgoing-orphan-projection',
    'Ledger rows belong to live payments',
    'ERROR',
    'A SupplierPayment referenced by a payment that is not PAID or REVERSED means money recorded without its authorisation trail.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT op.number AS id FROM outgoing_payments op
      WHERE op."restaurantId" = ${restaurantId}
        AND op."supplierPaymentId" IS NOT NULL
        AND op.status NOT IN ('PAID', 'REVERSED')
      LIMIT 200
    `,
  )

  add(
    'outgoing-cash-unrecorded',
    'Cash payments reached a drawer',
    'WARNING',
    'A PAID cash payment with no drawer movement left the safe outside any till count — real, but worth eyes (same rule as unrecorded refunds).',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT op.number AS id FROM outgoing_payments op
      WHERE op."restaurantId" = ${restaurantId}
        AND op.method = 'CASH' AND op.status IN ('PAID', 'REVERSED')
        AND NOT EXISTS (
          SELECT 1 FROM cash_movements m WHERE m."outgoingPaymentId" = op.id
        )
      LIMIT 200
    `,
  )

  add(
    'outgoing-reversal-shape',
    'Reversals and their originals pair up',
    'ERROR',
    'A REVERSED payment must have its reversal row, and every reversal must point at a REVERSED original.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT op.number AS id FROM outgoing_payments op
      WHERE op."restaurantId" = ${restaurantId}
        AND (
          (op.status = 'REVERSED' AND NOT EXISTS (
            SELECT 1 FROM outgoing_payments r WHERE r."reversalOfId" = op.id
          ))
          OR
          (op."reversalOfId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM outgoing_payments o2
            WHERE o2.id = op."reversalOfId" AND o2.status = 'REVERSED'
          ))
        )
      LIMIT 200
    `,
  )

  const status: IntegrityStatus = checks.some((check) => check.status === 'ERROR')
    ? 'ERROR'
    : checks.some((check) => check.status === 'WARNING')
      ? 'WARNING'
      : 'OK'

  return { ranAt: new Date().toISOString(), status, checks }
}
