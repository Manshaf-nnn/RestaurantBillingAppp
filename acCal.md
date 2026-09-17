TABLEFLOW — ACCOUNTANT CONTROL CENTER

Improve the existing TableFlow system by creating a simple,
professional Accountant Control Center.

FIRST inspect the existing codebase and reuse all existing
accounting, billing, payment, inventory, COGS, reconciliation,
audit and reporting logic. DO NOT create duplicate calculation
logic or break existing functionality.

CORE RULE:
Every feature must be EASY TO UNDERSTAND and EASY TO USE.
Do not add unnecessary buttons, settings, filters, fields or
complex options.

The accountant should understand each screen without training.

==================================================
FEATURES
==================================================

1. ACCOUNTANT DASHBOARD
Show only important numbers:
- Sales
- Net Revenue
- COGS
- Gross Profit
- Cash
- Inventory Value
- Receivables
- Payables
- Reconciliation Issues
- Pending Approvals

Every number should be clickable and show "Why is this number?"

2. ACCOUNTING CALCULATOR
Simple calculator with:
- Tax
- Discount
- Margin
- Markup
- Profit
- COGS
- Food Cost %
- Tax inclusive/exclusive
- Percentage
- Currency conversion

Keep it like a normal calculator, with accounting shortcuts.
Use existing backend calculations for financial results.

3. "WHY IS THIS NUMBER?"
Every important financial number should have:
[Explain]

Example:
Gross Profit LKR 425,500
→ Revenue 1,195,000
→ COGS 769,500
→ Gross Profit 425,500

Allow:
[View Transactions]

The accountant must be able to trace:
Profit → Sale → Invoice → Payment
and:
Profit → COGS → Recipe → Inventory → Purchase.

4. CASH RECONCILIATION
Show:
Expected Cash
Actual Cash
Difference

Example:
Expected: LKR 202,000
Actual: LKR 201,500
Difference: -LKR 500

If different, clearly show:
"Cash is short by LKR 500"

Allow a simple reason and approval.

5. PAYMENT RECONCILIATION
Compare:
Invoice Total
Payments
Refunds
Outstanding

Clearly identify:
Paid
Partially Paid
Unpaid
Overpaid
Mismatch

6. BANK RECONCILIATION
Allow bank statement import where supported.

Automatically suggest matches using:
- Amount
- Date
- Reference

Show simple statuses:
Matched
Unmatched
Duplicate

Make accepting/rejecting a match very easy.

7. ACCOUNTING ERROR CHECK
Create a simple "Issues" screen.

Detect:
- Duplicate payments
- Duplicate invoices
- Cash differences
- Inventory differences
- Unusual discounts
- Unusual refunds
- Negative stock
- COGS mismatch
- Unbalanced journals
- Missing financial records
- Backdated transactions

Show:
🔴 Critical
🟠 Warning
🟢 Resolved

Click an issue → show exactly what happened and how to investigate it.

8. VARIANCE ANALYSIS
Compare Actual vs Previous/Budget where available.

Show:
Sales
COGS
Food Cost
Gross Profit
Waste
Discounts
Purchases

Example:
Food Cost
Expected 30%
Actual 35%
Variance +5%

Give a short data-based explanation.

9. JOURNALS & LEDGER
Provide simple access to:
- General Ledger
- Journal Entries
- Trial Balance
- Cash Book

Every entry must show its source transaction.

10. PURCHASE → INVENTORY → COGS
Make this traceable visually:

Purchase
→ Inventory
→ Recipe
→ Consumption
→ COGS
→ Gross Profit

The accountant should be able to follow the money/cost with one click.

11. MENU PROFITABILITY
Show:
- Item Sales
- Cost
- Gross Profit
- Margin

Clearly identify:
Most Profitable
Lowest Margin

12. WHAT-IF CALCULATOR
Simple simulation:

"If chicken price increases from 800 to 900/kg,
what happens to profit?"

Show the impact clearly.

THIS MUST NEVER CHANGE REAL ACCOUNTING DATA.

13. MONTH-END CLOSE
Create a simple checklist:

✓ Sales reconciled
✓ Payments reconciled
✓ Cash reconciled
✓ Inventory reconciled
✓ COGS completed
✓ Journals balanced
⚠ 2 issues remaining

Show:
"92% Ready to Close"

Allow authorized users to close/reopen the period.

14. APPROVALS
One simple page for pending:
- Refunds
- Discounts
- Stock adjustments
- Manual journals
- Write-offs
- Backdated changes

Use:
Approve
Reject
View

Nothing unnecessary.

15. ACCOUNTANT REPORTS
Simple report center:
- P&L
- Balance Sheet
- Trial Balance
- Sales
- Purchases
- COGS
- Inventory
- Cash
- Payments
- Reconciliation
- Audit Trail

16. EXPORT
Simple:
[Export Excel]
[Export CSV]
[Export PDF]

Use current filters/data.

17. ACCOUNTANT NOTES
Allow a short note on important transactions/issues.

Example:
"Supplier invoice corrected due to duplicate quantity."

18. AI — ASK THE NUMBERS
Allow questions such as:

"Why did profit decrease?"
"Which items have the lowest margin?"
"Why did food cost increase?"
"Show unusual discounts."

AI MUST use real system data and show the source.
AI must NEVER invent or change financial numbers.

==================================================
UI / UX RULES
==================================================

MAKE EVERYTHING SIMPLE.

Each feature should answer:
"What is this?"
"What does this number mean?"
"What should I do?"

Use short labels and plain accounting language.

Examples:

Instead of:
"Reconciliation Variance Resolution Workflow"

Use:
"Cash Difference"

Instead of:
"Financial Transaction Traceability"

Use:
"Why is this number?"

Instead of:
"Exception Management"

Use:
"Issues"

Instead of:
"Period Finalization"

Use:
"Close Month"

Add small "ⓘ" help icons beside unfamiliar accounting terms.

When clicked, show a short explanation.

Example:

ⓘ COGS
"Cost of the ingredients used to make the items sold."

Use short tooltips for buttons.

Example:
ⓘ Explain
"See how this number was calculated."

ⓘ Reconcile
"Compare recorded transactions with actual money."

ⓘ Close Month
"Lock this accounting period after all checks are complete."

Do NOT overload the UI with explanations.
Use progressive disclosure:
show the important information first,
show details only when the accountant clicks.

==================================================
IMPORTANT ACCOUNTING RULES
==================================================

- Use existing authoritative billing/accounting calculations.
- Revenue, COGS, profit, payments and inventory must remain consistent.
- Use Decimal/integer minor units for money.
- Preserve historical financial records.
- Keep complete audit trails.
- Respect tenant and branch isolation.
- Enforce RBAC server-side.
- No real payment gateways.
- Never silently change accounting records.
- Never let AI become the source of financial truth.

==================================================
IMPLEMENTATION
==================================================

Do not build everything blindly at once.

First audit the existing system.

Then implement in this order:

1. Dashboard
2. Calculator
3. Number explanations/drilldowns
4. Cash/payment reconciliation
5. Issues
6. Variance
7. Ledger/reports
8. Inventory/COGS traceability
9. Month-end close
10. AI Accountant
11. Testing + performance + security

For every feature:
- reuse existing logic
- add backend validation
- add tests
- check permissions
- check tenant/branch isolation
- check financial integrity
- keep the UI simple

FINAL GOAL:

An accountant should open TableFlow and immediately know:

"What happened?"
"Where is the money?"
"Why is this number?"
"What is wrong?"
"What do I need to fix?"
"Is this month ready to close?"

Build it so a new accountant can understand the interface
without needing a long manual.