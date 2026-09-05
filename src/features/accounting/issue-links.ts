/**
 * Where each integrity check's example ids lead (acCal.md §7): click an
 * issue, land on the screen that explains it. Kept beside the checker but
 * out of it — the checker reports; the UI navigates.
 *
 * Checks whose examples are not row ids (numbers, keys) link to their list
 * screen instead.
 */

const ORDER_CHECKS = new Set([
  'order-line-sum',
  'discount-split',
  'paid-total',
  'unusual-discounts',
  'unusual-refunds',
  'unusual-cancellations',
  'consumption-without-order',
  'depletion-without-order',
])

const ITEM_CHECKS = new Set([
  'stock-replay',
  'branch-stock-sum',
  'negative-stock',
  'unusual-stock-adjustments',
  'unusual-wastage',
])

export function issueExampleHref(checkKey: string, exampleId: string): string {
  if (ORDER_CHECKS.has(checkKey)) return `/dashboard/orders/${exampleId}`
  if (ITEM_CHECKS.has(checkKey)) return `/dashboard/inventory/${exampleId}`
  if (checkKey === 'unusual-cash-variance') return `/dashboard/cash-drawer/${exampleId}`
  if (checkKey === 'void-concentration') return '/dashboard/audit-logs'
  if (
    checkKey === 'duplicate-payments' ||
    checkKey === 'backdated-transactions' ||
    checkKey === 'after-hours-activity'
  ) {
    // Payment ids are not routable; the sales report's payment view is.
    return '/dashboard/reports/sales'
  }
  if (checkKey.startsWith('outgoing-')) return '/dashboard/accounting/payments'
  if (checkKey.startsWith('loyalty')) return '/dashboard/loyalty'
  if (checkKey.startsWith('duplicate-invoice')) return '/dashboard/invoices'
  if (checkKey.startsWith('duplicate-order')) return '/dashboard/orders'
  return '/dashboard/accounting/reconciliation'
}

/** One plain sentence per check: what happened, and what to do about it. */
export function issueAdvice(checkKey: string): string {
  const advice: Record<string, string> = {
    'order-line-sum': 'A bill total disagrees with its own lines. Open the order and re-check its items.',
    'discount-split': 'A discount total is not the sum of its parts. Open the order and re-apply the discount.',
    'paid-total': 'A bill’s cached paid figure disagrees with its payment records. Open the order and check its payments and refunds.',
    'refund-excess': 'More was refunded against a payment than it ever took. This needs a correcting entry — talk to whoever processed it.',
    'duplicate-invoice-number': 'Two invoices share a number. Invoicing must be investigated before filing anything.',
    'duplicate-order-number': 'Two orders share a number. Investigate before trusting per-order reports.',
    'paid-without-invoice': 'Money was taken but no invoice exists. Open the order and issue the bill.',
    'loyalty-ledger': 'A customer’s points balance has no ledger entries to explain it.',
    'stock-replay': 'An item’s stock does not equal the sum of its movements. The stock ledger page shows the history.',
    'branch-stock-sum': 'Branch stocks do not add up to the item total.',
    'negative-stock': 'Stock has gone below zero — usually an unrecorded purchase or a wrong recipe quantity.',
    'consumption-without-order': 'Ingredients were consumed with no order behind them.',
    'depletion-without-order': 'A stock depletion points at no order.',
    'tenant-mismatch': 'A row belongs to two restaurants at once. Stop and investigate — this should be impossible.',
    'outgoing-paid-link': 'A supplier payment was marked paid but its ledger row is missing.',
    'outgoing-orphan-projection': 'A ledger row points at a payment that does not exist.',
    'outgoing-cash-unrecorded': 'A cash payment never reached a drawer. Record it or reverse it.',
    'outgoing-reversal-shape': 'A reversal and its original do not pair up.',
    'duplicate-payments': 'Two identical payments landed on one bill within two minutes — a double-tap, or the same payment keyed twice. If one is wrong, refund it with a reason.',
    'unusual-discounts': 'These discounts sit far outside the house pattern. If they were authorised, acknowledge with a note; if not, ask who gave them.',
    'unusual-refunds': 'These refunds are unusually large or unusually many. Check the reasons on each.',
    'backdated-transactions': 'Money was dated well before or after the event it belongs to. Verify the dates are honest.',
    'unusual-cancellations': 'Bills were cancelled with money still on them, or cancellations have jumped this week. Open each one and check the reason and whether a refund was due.',
    'void-concentration': 'One person has voided or cancelled far more than everyone else this week. Read their audit trail before drawing a conclusion.',
    'unusual-stock-adjustments': 'A manual stock adjustment was large — in money, or as a share of what was on the shelf. Check the reason on the item’s history.',
    'unusual-wastage': 'This item is being wasted far more than usual, or a large share of what leaves stock is going in the bin. Look at the wastage board for who, when and why.',
    'unusual-cash-variance': 'A drawer closed with a large counted difference, or the same cashier has been short repeatedly. Review the session and its variance note.',
    'after-hours-activity': 'Payments were taken outside the location’s opening hours. Check who was signed in and whether the hours on file are right.',
  }
  return advice[checkKey] ?? 'Open the linked records and verify them.'
}
