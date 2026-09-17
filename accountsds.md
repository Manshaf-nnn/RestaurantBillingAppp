# IMPLEMENTATION TASK — ACCOUNTANT + MAIN ADMIN FINANCIAL CONTROL MODULE

Act as a **Senior Restaurant Accountant + Financial Systems Architect + Senior Full-Stack Engineer**.

The existing TableFlow system already has billing, payments, inventory, purchasing, suppliers, COGS, reconciliation, daily close and reporting. **Do not break or duplicate those systems.** Build a new professional **Accountant module** on top of the existing authoritative services.

Before coding, inspect the current codebase, database schema, payment/purchasing/inventory/reporting services and existing permissions. Reuse existing calculation engines and ledgers wherever possible.

---

## 1. ACCOUNTANT MODULE

Create a dedicated **Accounting / Accountant** section in the dashboard.

Use a clean dropdown/sidebar structure such as:

* Accounting Dashboard
* Daily Sales
* Sales & Revenue
* Payments & Collections
* Cash / Drawer Reconciliation
* Outstanding Receivables
* Supplier Payables
* Purchases
* Supplier Payments
* Expenses
* Refunds
* Tax Report
* Service Charge / Tips
* COGS
* Gross Profit
* Inventory Valuation
* Inventory Reconciliation
* Waste
* Stock Adjustments
* Customer / Loyalty
* Daily Close
* Accounting Periods
* Payment Approval
* Audit Trail
* Financial Reconciliation
* Exports

You may improve this structure if a professional restaurant accounting workflow requires something better.

Every report must use the **existing authoritative calculation services**. Never create competing formulas.

---

# 2. ACCOUNTING DASHBOARD

Show a clear financial summary for the selected:

**Restaurant → Branch → Business Date / Date Range**

Display:

* Gross Sales
* Discounts
* Loyalty Discounts
* Refunds
* Net Sales / Revenue
* Tax Collected
* Service Charges
* Tips
* Total Billed
* Cash Collected
* Card Collected
* Bank Transfer
* QR / Online / Wallet / Other
* Outstanding Amount
* COGS
* Gross Profit
* Gross Margin %
* Purchases
* Supplier Payables
* Supplier Payments
* Expenses
* Waste Value
* Inventory Value
* Cash Drawer Variance

Every important number should be **clickable/drillable** into the underlying transactions.

Clearly distinguish:

**Revenue ≠ Payments ≠ Purchases ≠ COGS ≠ Expenses ≠ Cash Balance**

Never label Gross Profit as Net Profit unless operating expenses are properly included.

---

# 3. PAYMENT / COLLECTION REPORT

Accountant must be able to see every payment:

* Invoice
* Order
* Customer
* Branch
* Cashier
* Date/time
* Payment method
* Amount
* Reference
* Status
* Refunds
* Net received
* Cash drawer/shift
* Authorised by

Filters:

* Date range
* Branch
* Payment method
* Cashier
* Status
* Customer
* Invoice/order

Totals must reconcile exactly with invoices and payment records.

---

# 4. SUPPLIER ACCOUNTING / PAYABLES

Build a proper **Supplier Payables** system.

For each supplier show:

* Opening payable
* Purchases received
* Returns
* Credits/adjustments
* Payments made
* Outstanding payable
* Closing payable

Supplier statement must be drillable:

**Purchase Order → Goods Receipt → Supplier Bill/Payable → Payment**

Purchases must only become inventory when received.

Purchases must NOT automatically become COGS.

---

# 5. ACCOUNTANT PAYMENTS TO SUPPLIERS / EXPENSES

Accountants need the ability to record outgoing business payments such as:

### Supplier payment

* Supplier
* Amount
* Payment method
* Reference
* Invoice/bill references
* Payment date
* Branch
* Notes
* Supporting attachment if supported

### Other business expense

Examples:

* Rent
* Utilities
* Salaries/wages
* Maintenance
* Cleaning
* Transport
* Marketing
* Software
* Bank charges
* Miscellaneous

Create an **Expense Category** system.

Every expense must contain:

* Category
* Amount
* Payment method
* Date
* Branch
* Description
* Reference
* Created by
* Status
* Approval information

Do NOT mix restaurant operating expenses with COGS or inventory purchases.

---

# 6. ACCOUNTANT PAYMENT WORKFLOW

Important:

An accountant recording a payment does **not automatically mean the payment is finally approved**.

Use:

**DRAFT → SUBMITTED → PENDING ADMIN APPROVAL → APPROVED / REJECTED → PAID**

For approved payments:

* Record payment transaction
* Record payment method
* Update supplier/expense payable
* Update cash/bank ledger as appropriate
* Create audit entry
* Preserve immutable history

Do not allow editing/deleting completed payments.

Corrections must use reversal/adjustment transactions.

---

# 7. MAIN ADMIN APPROVAL CENTER

Create a separate:

**Main Admin → Payment Approvals**

Main Admin can see all accountant-submitted payments requiring approval.

Each request must show:

* Payment type
* Supplier/expense
* Amount
* Branch
* Accountant
* Date
* Payment method
* Reference
* Reason/description
* Related invoice/PO
* Supporting document
* Current status
* Submission time
* Previous approval/rejection history

Actions:

### APPROVE

Requires confirmation and optional comment.

### REJECT

Requires rejection reason.

### VIEW DETAILS

Show complete transaction history and supporting records.

### SEND BACK / REQUEST CHANGES

If useful, allow admin to return it to accountant without deleting the request.

Main Admin must see:

* Pending amount
* Approved amount
* Rejected amount
* Paid amount
* Payments by branch
* Payments by supplier/category

---

# 8. PAYMENT APPROVAL SECURITY

Implement strict RBAC.

Suggested permissions:

* ACCOUNTING_VIEW
* ACCOUNTING_CREATE_PAYMENT
* ACCOUNTING_SUBMIT_PAYMENT
* ACCOUNTING_APPROVE_PAYMENT
* ACCOUNTING_REJECT_PAYMENT
* ACCOUNTING_MANAGE_EXPENSE
* ACCOUNTING_VIEW_SUPPLIERS
* ACCOUNTING_CLOSE

Normal accountants **cannot approve their own payments**.

Main Admin / authorised management approves payments.

Prevent:

* Self-approval
* Duplicate approval
* Duplicate payment
* Amount modification after approval
* Cross-restaurant access
* Cross-branch access where not permitted

Use existing `restaurantId`, branch guards and permission architecture.

All approval/payment actions must be audited.

---

# 9. FINANCIAL LEDGER

Do not create an unnecessary second accounting system if existing ledgers can be extended.

Every financial event should have a traceable source:

**Sales → Payment → Drawer/Collection**

**Purchase → Goods Receipt → Inventory**

**Supplier Bill → Payable → Supplier Payment**

**Expense → Payable/Expense → Payment**

**Refund → Refund → Cash/Payment reversal**

**Stock → Consumption/Waste/Adjustment → COGS/Inventory**

Every amount must be explainable from source transactions.

---

# 10. CORE ACCOUNTING REPORTS

Implement professional reports including:

### Sales

* Gross sales
* Discounts
* Refunds
* Net sales
* Tax
* Service charge
* Tips
* Total billed

### Collections

* Cash
* Card
* Bank transfer
* QR
* Online
* Wallet
* Other
* Outstanding

### Supplier

* Supplier statement
* Purchases
* Returns
* Payments
* Outstanding payable
* Aging

### Expenses

* Expense by category
* Expense by branch
* Expense by date
* Payment method
* Approved vs pending

### Profitability

* Revenue
* COGS
* Gross Profit
* Gross Margin
* Expense totals
* If sufficient data exists, operating profit — clearly labelled

### Inventory

* Opening stock
* Purchases
* Consumption
* Waste
* Adjustments
* Transfers
* Closing stock
* Inventory value

### Tax

* Taxable sales
* Tax collected
* Tax-inclusive/exclusive breakdown
* Refund impact

### Cash

* Opening drawer
* Cash sales
* Cash refunds
* Cash movements
* Expected closing
* Actual closing
* Variance

### Daily Close

Provide the complete accountant daily closing report.

---

# 11. RECONCILIATION

Build a dedicated **Financial Reconciliation** screen.

Automatically check:

**Sales = invoice totals**

**Payments = collected amounts**

**Outstanding = billed − net payments**

**Inventory = opening + purchases + transfers − consumption − waste ± adjustments**

**COGS = inventory consumption cost**

**Gross Profit = Net Sales − COGS**

**Supplier Payable = purchases/credits − supplier payments**

**Cash = opening cash + cash inflows − cash outflows**

Any mismatch must show:

* OK
* WARNING
* ERROR

with clickable records explaining the difference.

---

# 12. DATE / PERIOD CONTROL

All reports must respect:

* Restaurant timezone
* Branch
* Business date
* Accounting period
* Daily close

Closed accounting periods cannot silently be changed.

Corrections after closing must be recorded as new adjustment/refund transactions in the current open period and audited.

---

# 13. EXPORTS

Every major report should support:

* CSV
* Excel
* PDF where appropriate

Exports must contain:

* Restaurant
* Branch
* Report name
* Date range
* Filters
* Currency
* Generated timestamp
* Correct human-readable amounts

Exported numbers must exactly match the screen.

---

# 14. UI / UX

Make this feel like a **professional restaurant accounting application**, not a generic admin page.

Priorities:

**Accuracy → clarity → reconciliation → drill-down → usability**

Use:

* Summary cards
* Tables
* Filters
* Date presets
* Branch selector
* Report dropdown
* Status badges
* Drill-down links
* Approval queues
* Confirmation dialogs
* Empty/loading/error states

Accountants should be able to answer:

> "Where did this number come from?"

within a few clicks.

---

# 15. AUDIT TRAIL

Audit:

* Payment created
* Payment submitted
* Payment approved
* Payment rejected
* Payment paid
* Payment reversed
* Expense created/changed
* Supplier payment
* Refund
* Daily close
* Period close/reopen
* Accounting adjustments

Store:

* Actor
* Timestamp
* Restaurant
* Branch
* Before
* After
* Reason
* Related record

Financial records should be immutable after completion.

---

# 16. TESTING — VERY IMPORTANT

Before declaring complete, create tests for:

1. Supplier payment workflow
2. Expense workflow
3. Accountant submits payment
4. Admin approves payment
5. Admin rejects payment
6. Accountant cannot approve own payment
7. Duplicate approval/payment prevention
8. Partial supplier payment
9. Supplier payable reconciliation
10. Cash reconciliation
11. Sales/payment reconciliation
12. Inventory/COGS reconciliation
13. Daily close
14. Closed-period protection
15. Cross-tenant protection
16. Cross-branch protection
17. Audit trail
18. Concurrent payment attempts
19. Refund interaction
20. Report/export agreement

Add an end-to-end accountant test:

**Purchase → Goods Receipt → Supplier Payable → Accountant Payment Request → Admin Approval → Payment → Supplier Balance → Cash/Bank movement → Reports → Reconciliation**

Everything must reconcile.

---

# 17. IMPLEMENTATION RULES

Before coding:

1. Audit the existing accounting, payment, supplier, purchase, expense, inventory and reporting code.
2. Identify reusable services.
3. Do not duplicate `computeTotals`, payment calculations, inventory ledger, COGS, revenue or reconciliation logic.
4. Propose the DB changes and architecture.
5. Implement in small safe migrations.
6. Preserve existing data.
7. Do not introduce payment gateways.
8. Use manual payment recording only.
9. Run existing tests after every major change.
10. Add new regression tests.
11. Run TypeScript/lint/build/migrations/verification before completion.

### FINAL ACCEPTANCE TEST

A restaurant accountant should be able to open the Accounting module and answer:

* How much did we sell?
* How much money did we actually collect?
* How much is outstanding?
* How much cash should be in the drawer?
* What are our supplier payables?
* Who did we pay?
* Which payments are waiting for approval?
* What expenses did we have?
* How much inventory do we have?
* What did inventory cost us?
* What is our COGS?
* What is our gross profit?
* Why did the inventory value change?
* Why did the cash balance change?
* Why does a supplier have this outstanding balance?
* Who approved each payment?
* Can I trace every number back to the original transaction?

If any answer cannot be explained through drill-down records, the feature is **not complete**.

Start with a **read-only architecture/code audit first**. Do not modify code until you have identified the existing services, models, permissions, calculations and integration points.
