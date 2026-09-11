TABLEFLOW — BILL CUSTOMIZATION, PAYMENT DESTINATIONS & APPROVALS

First inspect the existing billing, payment, accounting, inventory, branch, user/role and approval systems.

DO NOT rebuild working systems or create duplicate logic. Reuse the existing authoritative logic.

==================================================
1. BILL CUSTOMIZATION
==================================================

In Settings → Bill / Receipt, allow the owner to choose exactly what appears on the bill.

EVERY OPTION MUST BE OPTIONAL.

Allow the owner to enable/disable:

- Restaurant logo
- Restaurant name
- Address
- Phone number
- Staff/Cashier name
- Invoice number
- Date/time
- Customer details
- Item details
- Quantity
- Unit price
- Discount
- Subtotal
- Service charge
- Tax
- Rounding
- Grand total
- Payment method
- Paid amount
- Balance/change
- Footer/message

The owner controls the visibility of each item.

IMPORTANT:
If Service Charge is enabled, show it even when the value is 0.

Example:
Service Charge: LKR 0.00

Do not hide zero values when that bill option is enabled.

Logo:
- Support colour or black/white images.
- For monochrome thermal printers, automatically print the logo correctly in black/white.
- Keep the printed bill clean and readable.

The receipt must use the existing backend billing calculations.
Never create separate calculations inside the receipt UI.

==================================================
2. PAYMENT DESTINATION SETTINGS
==================================================

Because TableFlow does NOT use real payment gateways or bank APIs, allow the owner to configure an accounting destination for each payment method.

Example:

Cash → BOC
Card → HNB
Online Transfer → NDB

When a cashier records:

LKR 1,500
Cash

the payment should be recorded as:

Amount: LKR 1,500
Method: Cash
Destination: BOC

This is an accounting allocation only.
DO NOT pretend that TableFlow transferred money to the bank.

Support split payments:

LKR 1,000 Cash → BOC
LKR 500 Card → HNB

Every payment must remain traceable to:
Invoice → Payment → Method → Destination → Accounting → Reconciliation.

If a payment method has no destination configured, prevent settlement and clearly tell the cashier to contact an administrator.

==================================================
3. CENTRAL APPROVALS
==================================================

Create one simple Main Admin → Approvals page.

Requests from ANY branch/staff member that require approval should appear here.

Examples:

- Stock Transfer
- Stock Adjustment
- Money In
- Money Out
- Refund
- Large Discount
- Stock Write-off
- Inventory Variance
- Manual Accounting Adjustment
- Other existing approval-controlled actions

Each request should clearly show:

WHAT
WHY
AMOUNT / QUANTITY
BRANCH
REQUESTED BY
DATE/TIME
RELATED RECORD

Example:

REQUEST FOR MONEY OUT
Branch: Kandy
Amount: LKR 25,000
Requested by: Staff Name
Reason: Emergency purchase

Actions:

[Approve] [Reject]

Rejecting should require a reason.

Statuses:

Pending
Approved
Rejected
Cancelled

==================================================
4. SECURITY & AUDIT
==================================================

Approval permissions must be enforced on the backend.

Respect existing:
- RBAC
- Tenant isolation
- Branch isolation
- User permissions

Do not allow unauthorized users to approve requests.

Every approval/rejection must be permanently audited with:
who, what, when, branch, old status, new status and reason.

Do not directly edit historical financial records.

==================================================
5. IMPORTANT
==================================================

Reuse existing:

Billing
Payments
Accounting
Inventory Ledger
COGS
Users/Roles
Branches
Audit Logs
Approval logic
Printing
Design System

Do not create duplicate systems.

Use existing Decimal/minor-unit money logic, transactions, locking and idempotency.

After implementation:

- Run existing tests.
- Add tests for the new features.
- Test billing and printing.
- Test zero service charge.
- Test payment destinations.
- Test split payments.
- Test approval/rejection.
- Test permissions and branch isolation.
- Verify existing POS, inventory, accounting and reports still work.

Keep the UI simple, professional and easy for restaurant owners and staff to understand.