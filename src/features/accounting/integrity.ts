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

  // ── The accountant's pattern checks (acCal.md §7) ─────────────────────────
  //
  // WARNINGS, deliberately: each row here is legal on its own — the checks
  // exist so a human looks. Thresholds live in the SQL where they can be
  // read next to the question they ask.

  add(
    'duplicate-payments',
    'No suspicious double payments',
    'WARNING',
    'Two settled payments on one order, same method and amount, within 120 seconds — a double-tap or a double-key.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT p2.id FROM payments p1
      JOIN payments p2 ON p2."orderId" = p1."orderId"
        AND p2.method = p1.method
        AND p2.amount = p1.amount
        AND p2.id > p1.id
        AND p2."paidAt" IS NOT NULL AND p1."paidAt" IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (p2."paidAt" - p1."paidAt"))) <= 120
      WHERE p1."restaurantId" = ${restaurantId}
        AND p1.status IN ('PAID','REFUNDED') AND p2.status IN ('PAID','REFUNDED')
        AND p1.amount > 0
      LIMIT 200
    `,
  )

  add(
    'unusual-discounts',
    'No discounts far outside the house pattern',
    'WARNING',
    'Last 30 days: a discount above 25% of the bill AND 3× the median discounted order — or above 50% when too few discounted orders exist to set a pattern.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      WITH recent AS (
        SELECT id, "discountTotal" + "loyaltyDiscount" AS disc, subtotal
        FROM orders
        WHERE "restaurantId" = ${restaurantId}
          AND status <> 'CANCELLED'
          AND subtotal > 0
          AND "placedAt" >= NOW() - INTERVAL '30 days'
      ),
      pattern AS (
        SELECT COUNT(*) AS n,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY disc) AS median
        FROM recent WHERE disc > 0
      )
      SELECT r.id FROM recent r, pattern p
      WHERE (p.n >= 20 AND r.disc * 4 > r.subtotal AND r.disc > 3 * p.median)
         OR (p.n < 20 AND r.disc * 2 > r.subtotal)
      LIMIT 200
    `,
  )

  add(
    'unusual-refunds',
    'No refunds far outside the house pattern',
    'WARNING',
    'Last 30 days: a refund of 75%+ of its bill, or three or more refunds against one order.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT o.id FROM orders o
      WHERE o."restaurantId" = ${restaurantId}
        AND o."placedAt" >= NOW() - INTERVAL '30 days'
        AND o."grandTotal" > 0
        AND (
          EXISTS (SELECT 1 FROM refunds r
            WHERE r."orderId" = o.id AND r.amount * 4 >= o."grandTotal" * 3)
          OR (SELECT COUNT(*) FROM refunds r WHERE r."orderId" = o.id) >= 3
        )
      LIMIT 200
    `,
  )

  add(
    'backdated-transactions',
    'No transactions dated into the past',
    'WARNING',
    'A payment taken before its order existed or 48h+ after it, or money-out dated inside a period that was already sealed when the record was created.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM payments p
      JOIN orders o ON o.id = p."orderId"
      WHERE p."restaurantId" = ${restaurantId}
        AND p.status IN ('PAID','REFUNDED')
        AND p."paidAt" IS NOT NULL
        AND (p."paidAt" < o."placedAt" - INTERVAL '5 minutes'
             OR p."paidAt" > o."placedAt" + INTERVAL '48 hours')
      UNION ALL
      SELECT op.number AS id FROM outgoing_payments op
      JOIN accounting_periods ap ON ap."restaurantId" = op."restaurantId"
        AND ap.status = 'CLOSED'
        AND op."paymentDate" BETWEEN ap."periodStart" AND ap."periodEnd"
      WHERE op."restaurantId" = ${restaurantId}
        AND op.status IN ('PAID','APPROVED','SUBMITTED')
        AND op."createdAt" > COALESCE(ap."closedAt", op."createdAt" - INTERVAL '1 second')
      LIMIT 200
    `,
  )

  // ── COGS (production.md §1) ────────────────────────────────────────────────
  //
  // The ledger checks above prove stock BALANCES explain themselves. These ask
  // the next question, which nothing was asking: does the stock that left carry
  // the VALUE it should, so that cost of sales is not quietly understated.
  // A sale depleted at zero cost still moves the quantity correctly — every
  // balance check stays green — while gross profit reads high for ever.

  add(
    'cogs-uncosted-sale',
    'Sold stock carries a cost',
    'WARNING',
    'A SALE movement with no unitCost contributes nothing to cost of sales, so profit reads high. ' +
      'Lines depleted before costs were stamped are expected here and are the reason this is a warning, not an error; ' +
      'a rising count means new sales are being depleted uncosted.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT sm.id FROM stock_movements sm
      JOIN inventory_items ii ON ii.id = sm."itemId"
      WHERE sm."restaurantId" = ${restaurantId}
        AND sm.type IN ('SALE', 'CONSUMPTION')
        AND COALESCE(sm."unitCost", 0) = 0
        AND ii."costPerUnit" > 0
      LIMIT 200
    `,
  )

  add(
    'cogs-above-revenue',
    'No line costs more than it sold for',
    'WARNING',
    'A line whose snapshotted cost exceeds what the guest paid for it. Legitimate for a loss leader or a ' +
      'mispriced dish, but it is also what a unit-conversion error looks like, so it is worth eyes.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT oi.id FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      WHERE o."restaurantId" = ${restaurantId}
        AND o.status <> 'CANCELLED'
        AND oi.status <> 'CANCELLED'
        AND oi."costPrice" > 0
        AND oi."costPrice" * oi.quantity > oi."lineTotal"
      LIMIT 200
    `,
  )

  // ── Bank reconciliation (production.md §1) ────────────────────────────────
  //
  // Statement lines were imported and matched with nothing checking the result.
  // Both of these break the point of reconciling at all: the first explains one
  // receipt with two bank lines, the second leaves a row that contradicts
  // itself about whether it was reconciled.

  add(
    'bank-double-match',
    'No receipt is reconciled twice',
    'ERROR',
    'Two statement lines claim the same payment. The bank balance is then explained twice over and the ' +
      'reconciliation appears to close while real money is unaccounted for.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT MIN(id) AS id FROM bank_statement_lines
      WHERE "restaurantId" = ${restaurantId}
        AND status = 'MATCHED'
        AND "matchedId" IS NOT NULL
      GROUP BY "matchedType", "matchedId"
      HAVING COUNT(*) > 1
      LIMIT 200
    `,
  )

  /*
   * There is deliberately no "a matched line says what it matched" check here.
   *
   * The `bank_statement_lines_match_shape` CHECK constraint (migration
   * 20260916090000_accountant_control_center) already makes that state
   * impossible to store: `(status = 'MATCHED') = (matchedType IS NOT NULL AND
   * matchedId IS NOT NULL)`. A checker entry for it would report OK for ever
   * without ever being capable of reporting anything else, which is worse than
   * no entry — it reads as coverage. The double-match above is the failure the
   * constraint cannot see, because each row is individually well-formed.
   */

  const status: IntegrityStatus = checks.some((check) => check.status === 'ERROR')
    ? 'ERROR'
    : checks.some((check) => check.status === 'WARNING')
      ? 'WARNING'
      : 'OK'

  return { ranAt: new Date().toISOString(), status, checks }
}
