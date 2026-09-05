import 'server-only'

import { Prisma } from '@prisma/client'

import { getApprovalPolicy } from '@/features/approvals/service'
import { DAY_KEYS, parseOpeningHours } from '@/lib/opening-hours'
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

  // The tenant's own thresholds for what counts as "big" — the same numbers
  // that decide when an adjustment or a drawer difference needs a signature.
  // A threshold of zero means "not configured", never "flag everything".
  const policy = await getApprovalPolicy(restaurantId)
  const NEVER = 2 ** 53
  const adjustmentFloor = policy.adjustmentValueAbove > 0 ? policy.adjustmentValueAbove : NEVER
  const cashFloor = policy.cashVarianceAbove > 0 ? policy.cashVarianceAbove : NEVER

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

  // ── Anomaly alerts (smart.md §7) ───────────────────────────────────────────
  //
  // Still WARNINGS, still "a human looks": cancellations, voids, hand
  // adjustments, waste, drawer differences and after-hours trade are all
  // legitimate on their own. Each check names the rows so a reviewer can start
  // somewhere; nothing here changes a financial record.

  add(
    'unusual-cancellations',
    'No cancellations outside the house pattern',
    'WARNING',
    'Last 30 days: a bill cancelled with money still on it (paid, never refunded), or three or more ' +
      'cancellations this week when that is more than double the weekly run-rate of the three weeks before.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      WITH weekly AS (
        SELECT COUNT(*) FILTER (WHERE "cancelledAt" >= NOW() - INTERVAL '7 days') AS c7,
               COUNT(*) FILTER (WHERE "cancelledAt" <  NOW() - INTERVAL '7 days'
                                  AND "cancelledAt" >= NOW() - INTERVAL '28 days') / 3.0 AS weekly_avg
        FROM orders
        WHERE "restaurantId" = ${restaurantId} AND status = 'CANCELLED'
      )
      SELECT o.id FROM orders o, weekly w
      WHERE o."restaurantId" = ${restaurantId}
        AND o.status = 'CANCELLED'
        AND o."cancelledAt" >= NOW() - INTERVAL '30 days'
        AND ( o."paidTotal" > 0
           OR (o."cancelledAt" >= NOW() - INTERVAL '7 days' AND w.c7 >= 3 AND w.c7 > 2 * w.weekly_avg) )
      LIMIT 200
    `,
  )

  add(
    'void-concentration',
    'No one person voids far more than everyone else',
    'WARNING',
    'Last 7 days: one person with ten or more voids or cancellations, and more than three times the ' +
      'average of everyone else who did any. Examples are audit-log entries.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      WITH per_actor AS (
        SELECT "userId", COUNT(*) AS n FROM audit_logs
        WHERE "restaurantId" = ${restaurantId}
          AND action IN ('order.cancelled', 'order.item_voided')
          AND "createdAt" >= NOW() - INTERVAL '7 days'
          AND "userId" IS NOT NULL
        GROUP BY "userId"
      ),
      everyone AS (SELECT SUM(n) AS total, COUNT(*) AS actors FROM per_actor)
      SELECT al.id FROM audit_logs al
      JOIN per_actor pa ON pa."userId" = al."userId"
      CROSS JOIN everyone e
      WHERE al."restaurantId" = ${restaurantId}
        AND al.action IN ('order.cancelled', 'order.item_voided')
        AND al."createdAt" >= NOW() - INTERVAL '7 days'
        AND pa.n >= 10
        AND (e.actors = 1 OR pa.n > 3.0 * (e.total - pa.n) / (e.actors - 1))
      LIMIT 200
    `,
  )

  add(
    'unusual-stock-adjustments',
    'No hand adjustment moved an unusual amount of stock',
    'WARNING',
    'Last 30 days: a manual adjustment worth at least the approval threshold, or one that moved a quarter ' +
      'or more of what was on the shelf. Examples are items.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT sm."itemId" AS id FROM stock_movements sm
      WHERE sm."restaurantId" = ${restaurantId}
        AND sm.type IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'ADJUSTMENT')
        AND sm."createdAt" >= NOW() - INTERVAL '30 days'
        AND ( ABS(sm.quantity) * sm."unitCost" >= ${adjustmentFloor}
           OR ( sm."balanceAfter" IS NOT NULL
                AND (sm."balanceAfter" - sm.quantity) > 0
                AND ABS(sm.quantity) >= 0.25 * (sm."balanceAfter" - sm.quantity) ) )
      LIMIT 200
    `,
  )

  add(
    'unusual-wastage',
    'No item is being wasted far outside its pattern',
    'WARNING',
    'Items wasted three or more times in 30 days where a fifth or more of everything that left stock went ' +
      'in the bin, or where this week’s waste value is more than double the weekly average of the three weeks before.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      WITH w AS (
        SELECT "itemId",
               SUM(quantity) AS waste30,
               COUNT(*) AS n30,
               COALESCE(SUM("costValue") FILTER (WHERE "createdAt" >= NOW() - INTERVAL '7 days'), 0) AS v7,
               COALESCE(SUM("costValue") FILTER (WHERE "createdAt" <  NOW() - INTERVAL '7 days'
                                                   AND "createdAt" >= NOW() - INTERVAL '28 days'), 0) / 3.0 AS v_weekly
        FROM wastage_records
        WHERE "restaurantId" = ${restaurantId}
          AND status <> 'REJECTED'
          AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY "itemId"
      ),
      u AS (
        SELECT "itemId", -SUM(quantity) AS used30 FROM stock_movements
        WHERE "restaurantId" = ${restaurantId}
          AND type IN ('SALE', 'CONSUMPTION', 'PRODUCTION_CONSUMPTION', 'SALE_REVERSAL')
          AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY "itemId"
      )
      SELECT w."itemId" AS id FROM w LEFT JOIN u ON u."itemId" = w."itemId"
      WHERE w.n30 >= 3
        AND ( w.waste30 >= 0.2 * (GREATEST(COALESCE(u.used30, 0), 0) + w.waste30)
           OR (w.v7 > 0 AND w.v_weekly > 0 AND w.v7 > 2 * w.v_weekly) )
      LIMIT 200
    `,
  )

  add(
    'unusual-cash-variance',
    'No drawer closed with an unusual difference',
    'WARNING',
    'Last 30 days: a counted difference at or above the review threshold, or the same cashier short ' +
      'three or more times. Examples are drawer sessions.',
    await prisma.$queryRaw<Array<{ id: string }>>`
      WITH short_runs AS (
        SELECT "closedById", COUNT(*) AS shorts FROM cash_drawer_sessions
        WHERE "restaurantId" = ${restaurantId}
          AND status IN ('CLOSED', 'PENDING_REVIEW')
          AND variance < 0
          AND "closedAt" >= NOW() - INTERVAL '30 days'
          AND "closedById" IS NOT NULL
        GROUP BY "closedById"
      )
      SELECT s.id FROM cash_drawer_sessions s
      LEFT JOIN short_runs r ON r."closedById" = s."closedById"
      WHERE s."restaurantId" = ${restaurantId}
        AND s.status IN ('CLOSED', 'PENDING_REVIEW')
        AND s."closedAt" >= NOW() - INTERVAL '30 days'
        AND s.variance IS NOT NULL AND s.variance <> 0
        AND ( ABS(s.variance) >= ${cashFloor}
           OR (s.variance < 0 AND COALESCE(r.shorts, 0) >= 3) )
      LIMIT 200
    `,
  )

  /*
   * After-hours trade needs opening hours to compare against, and only hours
   * somebody actually entered count: `parseOpeningHours` substitutes a default
   * week for an empty column, and judging a restaurant against hours it never
   * set would flag every late-night place on earth. No hours → the check runs,
   * finds nothing, and says why.
   */
  const hoursOwner = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { timezone: true, openingHours: true, branches: { select: { id: true, openingHours: true } } },
  })
  const windows: Array<{ branchId: string; dow: number; open: number; close: number }> = []
  for (const branch of hoursOwner?.branches ?? []) {
    const raw = branch.openingHours ?? hoursOwner?.openingHours ?? null
    if (!raw) continue
    const hours = parseOpeningHours(raw)
    DAY_KEYS.forEach((day, dow) => {
      const entry = hours[day]
      if (!entry || entry.closed) return
      const [oh, om] = entry.open.split(':').map(Number)
      const [ch, cm] = entry.close.split(':').map(Number)
      windows.push({ branchId: branch.id, dow, open: (oh || 0) * 60 + (om || 0), close: (ch || 0) * 60 + (cm || 0) })
    })
  }
  let zone = hoursOwner?.timezone || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    zone = 'UTC'
  }

  add(
    'after-hours-activity',
    'No payments taken outside opening hours',
    'WARNING',
    windows.length === 0
      ? 'Opening hours are not set for any location, so there is nothing to compare against. Set them under Locations to enable this check.'
      : 'Last 30 days: a payment taken more than an hour outside the location’s opening hours, in the restaurant’s own time. Examples are payments.',
    windows.length === 0
      ? []
      : await prisma.$queryRaw<Array<{ id: string }>>`
          WITH w(branch_id, dow, open_min, close_min) AS (
            VALUES ${Prisma.join(
              windows.map(
                (w) => Prisma.sql`(${w.branchId}::text, ${w.dow}::int, ${w.open}::int, ${w.close}::int)`,
              ),
            )}
          ),
          p AS (
            SELECT p.id, o."branchId" AS branch_id,
                   EXTRACT(DOW FROM ((p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone}))::int AS dow,
                   (EXTRACT(HOUR FROM ((p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone})) * 60
                    + EXTRACT(MINUTE FROM ((p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone})))::int AS m
            FROM payments p
            JOIN orders o ON o.id = p."orderId"
            WHERE p."restaurantId" = ${restaurantId}
              AND p.status IN ('PAID', 'REFUNDED')
              AND p."paidAt" IS NOT NULL
              AND p."paidAt" >= NOW() - INTERVAL '30 days'
              AND o."branchId" IN (${Prisma.join([...new Set(windows.map((w) => w.branchId))])})
          )
          SELECT p.id FROM p
          WHERE NOT EXISTS (
                  SELECT 1 FROM w
                  WHERE w.branch_id = p.branch_id AND w.dow = p.dow
                    AND ( (w.open_min <= w.close_min AND p.m >= w.open_min - 60 AND p.m < w.close_min + 60)
                       OR (w.open_min >  w.close_min AND p.m >= w.open_min - 60) ) )
            AND NOT EXISTS (
                  SELECT 1 FROM w
                  WHERE w.branch_id = p.branch_id AND w.dow = (p.dow + 6) % 7
                    AND w.open_min > w.close_min AND p.m < w.close_min + 60 )
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
