# Accounting

How money is recorded, derived and reported in TableFlow — the rules every
screen obeys, with pointers to the code that enforces them and the tests that
pin them.

## The one billing engine

Every bill in the product is priced by `computeTotals`
(`src/features/orders/pricing.ts`). No screen, export or report does its own
arithmetic. Order of operations:

1. **Subtotal** — the sum of active (non-voided) line totals, integer minor
   units throughout. There are no floats anywhere in money.
2. **Discounts** — `couponDiscount` and `manualDiscount` are separate columns
   and stay separate all the way to the database. When they exceed the bill,
   the coupon is honoured first and the manual discount takes the clamp.
   `discountTotal` is always their sum.
3. **Loyalty** — clamped to what remains after discounts.
4. **Service charge** — levied on the discounted base.
5. **Tax** — on base + service. In tax-inclusive mode the tax is *backed out*
   of the menu price for reporting; the guest's total is the menu price.
6. **Rounding** — to the nearest major unit, recorded as `roundingAdj`, never
   silent. `grandTotal = taxableBase + service + tax(exclusive) + roundingAdj`.

Pinned by `scripts/billing-math-test.ts` across 96 parameter combinations.

## Revenue methodology (§110)

**Revenue = net sales = goods sold − discounts − refunds.** Not tax, not
service charge, not tips. Every surface uses this one definition:

- the dashboard's headline (`getDashboardStats`, raw SQL over
  `subtotal − discountTotal − loyaltyDiscount` minus refunds),
- the sales report (`src/features/reports/sales.ts`),
- the reports hub, which computes nothing of its own — `getReportSummary`
  composes `getSalesReport`/`getProfitReport`/`getPaymentsReport`,
- the exports, whose labels say what each number is
  ("Tax collected (not revenue)", "Tips (staff money)").

Pinned by `scripts/report-agreement-test.ts`: for one seeded day of trade with
a tip, a coupon, a partial refund and a cancellation, the dashboard, the hub
and the sales report answer with the same number, and no revenue figure moves
by the tip.

## Tips

The tip is the staff's money passing through, never the restaurant's income.
`grandTotal` excludes it; `Order.tipAmount` carries it; **what the guest owes
is `grandTotal + tipAmount`**, computed in exactly one place —
`outstandingOn` in `pricing.ts` — used by the till, the payment intent, the
live board and every balance display.

## Payment recording methodology (§6)

No gateways, no tokenization, no webhooks. TableFlow *records* payments:
CASH, CARD, QR, ONLINE, WALLET, BANK_TRANSFER, OTHER, with a free-text
reference for the last two. A guest claiming a bank transfer creates an
**UNPAID** payment row carrying their reference — a claim is not money until
a cashier confirms it by capturing against that row.

- `capturePayment` locks the order row (`FOR UPDATE`) so a double-tap cannot
  settle twice; refuses amounts over what is due (exactly — no off-by-one
  slack) and cash tendered below the amount being booked.
- Partial payment is first-class: the till's amount field splits a bill
  across as many captures as needed; `paymentStatus` walks
  UNPAID → PARTIAL → PAID.
- **A payment row is immutable once settled.** Money going back is a
  `Refund` row: amount, reason, authoriser, several per payment for partial
  refunds. The payment flips to REFUNDED only when its refunds cover it.
  `paidTotal` is always *recomputed* as sum(received) − sum(returned), never
  incrementally adjusted.
- Refunds at or above `policy.refundAbove` stop until a manager approves
  (`ApprovalRequest`), same as discounts above `policy.discountAbove`.

Pinned by `scripts/payment-model-test.ts` (including the double-refund and
double-spend races).

## Invoices

An invoice is finalised **when the bill is presented**, not when it is paid
(`ensureInvoice`, `src/features/payments/service.ts`). Numbered
`INV-<year>-<seq>` from an atomic per-restaurant counter
(`restaurant_counters`) in the restaurant's own timezone year — concurrent
settlements cannot collide, and the number never changes after a guest has
seen it. The snapshot column freezes the bill as presented.

## The daily close and accounting periods (§50–51, §59)

- **DailyClose** — a person with `ACCOUNTING_CLOSE` signs off one local
  business date; the §51 accountant report (sales, payments by method,
  refunds, drawer variance, COGS, outstanding) is frozen as a snapshot
  nothing can rewrite. Closed days on the daily-close screen render the
  *stored* snapshot, deliberately, even if live figures have since changed.
- **AccountingPeriod** — a sealed range refuses cancellation, line voids,
  discount edits and guest changes to the orders inside it
  (`assertPeriodOpen`). New events dated today (a refund for last month's
  bill) are deliberately allowed — they land in today's open period, which is
  how accounting corrections work. Reopening is permitted and audited.
- No cron anywhere: days are closed when a person closes them.

Pinned by `scripts/structural-test.ts`.

## Loyalty (§72)

Loyalty is a ledger. Every earn (at settlement), spend (at order placement,
as a *conditional* decrement so two orders cannot spend the same points) and
give-back (on cancellation) writes a signed `LoyaltyEntry`;
`Customer.loyaltyPoints` is the cached sum, seeded with opening-balance
entries so `balance = Σ entries` holds from day one — and the integrity
checker verifies exactly that identity. Anonymous guests have **no** customer
record: a blank phone creates nothing, so nothing pools. Redeeming points is
a till operation (staff verify who is asking); the public order schema does
not accept `redeemPoints` at all.

## Integrity (§115–116)

`runIntegrityChecks` (`src/features/accounting/integrity.ts`) asks fourteen
questions the database should never answer yes to, each OK/WARNING/ERROR
with counts and example ids, shown live on the daily-close screen. Proven by
`scripts/hardening-test.ts`, which breaks the books on purpose and watches
the checker notice.

## The worked example (§101)

`scripts/e2e-reconciliation-test.ts` walks the spec's own numbers through the
real services: buy 100 kg of chicken at 800/kg (80,000), sell 100 curries at
0.5 kg each (COGS 40,000), waste 5 kg (4,000), and every report explains the
remainder: 45 kg worth 36,000 on the shelf, the ladder closing with zero
drift, and **purchases ≠ COGS** held everywhere.
