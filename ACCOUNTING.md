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

## The accountant module (accountsds.md)

Money going *out* has its own workflow. An `OutgoingPayment` (kind
`SUPPLIER` or `EXPENSE`) carries the whole lifecycle on its own status
enum — DRAFT → SUBMITTED → APPROVED/REJECTED → PAID, plus REVERSED and
CANCELLED — following the petty-cash precedent of a request that has a life
after approval. Every transition is a CAS `updateMany` on the expected
status, so a double-click, a race, or two owners deciding at once resolves
to exactly one winner. The one who submitted (or created) a payment can
never approve it: `ACCOUNTING_PAYMENT_APPROVE` lives with the owner/admin,
is excluded from the MANAGER preset, and is never in the ACCOUNTANT preset —
and `decide` refuses the submitter by id on top of that.

Nothing in the ledgers changed to make this work:

- **Supplier payments are projected, not reimplemented.** `markPaid` on a
  SUPPLIER payment creates the *existing* `SupplierPayment` row in the same
  transaction and stores its id (`supplierPaymentId`, unique). The supplier
  ledger's outstanding = received − paid − returned maths, and the suite
  that pins it, run unchanged.
- **Corrections reverse, never edit.** A PAID payment is immutable; `reverse`
  creates a *negating* SupplierPayment (negative amount) plus a linked
  reversal OutgoingPayment (1:1, DB-enforced), so both the mistake and the
  correction stay on the books. A second reversal of the same payment is
  refused.
- **Cash expenses reach the drawer** through the refund-helper pattern:
  method CASH posts an `EXPENSE_PAID` movement (system-only type) against an
  open session — payer's first, then any open at the branch — and skips
  silently when none is open, never blocking the money. Reversals post
  `EXPENSE_REVERSED`. Hand-keyed `CASH_PAID_OUT` therefore never
  double-counts with the workflow.
- **Sealed periods refuse backdating**: `submit` runs the payment date
  through `assertPeriodOpen`, the same guard the rest of the books use.

Expenses are the formal cost record, grouped by `ExpenseCategory` (ten
defaults seeded per restaurant; retiring a category hides it from new
expenses and keeps its name in history). Petty cash keeps its separate job:
small drawer cash, its own vocabulary, deliberately.

The screens live under `/dashboard/accounting`: the hub (§2's summary, every
card composed from the engines above and drillable), the payment console,
the owner's approval centre (§7 totals + queue), expenses, the supplier
payables statement (opening / received / returned / paid / closing per
supplier, built on the ledger's own predicates, with FIFO aging buckets),
and the financial reconciliation (§11) — the integrity checker plus the
money identities, each row linking to the screen that explains it. The
integrity checker itself gained four workflow checks (PAID-without-ledger-
row, orphaned projection, unrecorded cash, malformed reversal). Exports:
`outgoing`, `expenses` and `payables` types on the standard export route.

Pinned by `scripts/accounting-module-test.ts` (workflow guards, races,
reversal maths, payables statement) and `scripts/e2e-accountant-test.ts`
(the §16 chain: PO → GRN → payable → approval → paid → reconciled).

## The Accountant Control Center (acCal.md)

The accountant's own section, built on the engines above rather than beside
them. Ten screens under `/dashboard/accounting`, and one rule behind all of
them: **no screen computes a financial figure of its own**. Each one asks the
module that owns the number, which is why the hub, the ledger, the P&L and
the exports can never disagree.

### Why is this number?

`explain.ts` builds one explanation per metric — the formula with the real
figures, a plain sentence, and links to the records. The builders never
query: they arrange numbers the hub already produced, so a popover cannot
drift from the card it explains. `explain-test` folds every formula and
checks it lands on its own value.

The same builders answer **Ask the numbers** — a curated question list
("Why did profit change?", "Which items have the lowest margin?"). It is
deliberately **not** an LLM: every answer is computed from real records
before the page renders, and cites its sources. Nothing in this system can
invent a financial figure.

### The derived ledger (§9)

`src/features/ledger/` projects proper double-entry from the operating
records **at read time** — there is no journal table and no posting step, so
there is no second source of truth to drift. Twenty accounts, sixteen entry
shapes (sale, settlement, refund, COGS, goods received, supplier payment,
purchase return, expense, petty cash, wastage, stock adjustment, opening
stock, cash payout, bank deposit, drawer difference), each balanced by
construction and each line carrying the record that produced it.

`ledger-test` proves the accounting rather than the code: every entry
balances, the trial balance balances for any range, and — the checks that
matter — **ledger revenue IS the sales report's net sales, ledger COGS IS the
profit report's COGS, ledger payables IS the supplier ledger's outstanding**.
Cancelled bills contribute nothing.

Two honest omissions, both stated on the page. Cash moving between the till,
safe and change box is not projected (the business is no richer for carrying
its own money across the room, and the safe is not modelled), so the cash
book shows *trading* cash. And the balance-sheet view is called **Financial
position**, never a balance sheet: it is built only from what TableFlow
records, closes income and expenses into one clearly-labelled *Retained
earnings (derived)* line, and says in as many words that it is not accounts
for filing.

### Checks (§5, §6, §7)

One screen, four tabs. **Overview** is the identity list and integrity
checker. **Payments** classifies every bill as Paid / Partially paid /
Unpaid / Overpaid / Mismatch from `billed = grandTotal + tip` against
`received − refunded`, and says what to do about each problem row in words.
**Bank** imports a CSV or Excel statement the bank gives you and suggests
matches — exact amount only, direction-aware, within five days, with the
reference lifting the score; accepting is CAS-guarded so two clicks resolve
to one, and one system record can never be claimed by two lines. **Issues**
groups the checker's 22 checks as critical / worth-a-look / clear, each with
one sentence on what happened and links to the offending rows.

The four checks added here — duplicate payments, unusual discounts, unusual
refunds, backdated transactions — are WARNINGs by design: each row is legal
on its own, and the check exists so a person looks. A standing warning can be
**acknowledged with a note**; errors never can.

### Notes, close, tools

`AccountantNote` is append-only by construction — the feature ships no update
and no delete, so a wrong note is answered with another note. The same rows
carry issue acknowledgements.

**Close month** re-asks the records seven questions (days signed off, drawers
closed, no critical issues, nothing awaiting a decision, payments reconciled,
bank matched, journals balanced) and shows a readiness figure. Closing over
open items is allowed — accountants sometimes must — but demands the word
CLOSE and a written reason, both stored on the period. It reuses the existing
`closePeriod`, so a sealed month behaves like any sealed range.

**Tools** carries the calculator (tax inclusive/exclusive, margin vs markup,
food cost, manual-rate conversion — all in the billing engine's own integer
minor units, proven by `calc-math-test`) and **What if**, which prices an
ingredient change against the sales that actually happened. The what-if
service contains no writes at all, and its test counts every row before and
after to keep it that way.

Pinned by `scripts/ledger-test.ts`, `bank-rec-test.ts`, `month-close-test.ts`,
`what-if-test.ts`, `explain-test.ts` and `calc-math-test.ts`, plus the
payment-reconciliation and pattern-check sections added to
`accounting-module-test.ts` and `hardening-test.ts`.
