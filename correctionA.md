TABLEFLOW — FINAL UX, OPERATIONS & CONTROL-FLOW REFINEMENT

IMPORTANT:
DO NOT START CODING IMMEDIATELY.

First inspect the entire existing implementation, database schema, routes, RBAC, branches/locations, accounting, inventory ledger, approvals, cashier, kitchen production, shift handover, analytics and export logic.

Understand what already exists → reuse it → modify only what is necessary.
DO NOT rebuild working features, create duplicate business logic, or break existing POS/accounting/inventory/COGS logic.

IMPLEMENT THE FOLLOWING:

1. EXPORTS
Add a consistent Export option to every major feature where records/data exist:
Analytics, Cash Drawer, Transfers, Approvals, Shift Handover, Orders, Invoices, Inventory, Purchases, Production, Accounting/Reports, etc.
Support the existing appropriate export formats and respect current filters/date ranges/branch permissions.

2. TASK / TODO ASSIGNMENT
Owner/Main Admin can assign a task to any authorized staff member from any branch/location.
Show assignee + branch/location clearly.
Respect RBAC and tenant isolation.

3. ANALYTICS
Every analytics/report page must have a clear date/data-range selector:
Today, Yesterday, This Week, This Month, Custom Range, etc.
All numbers must update from the selected range.

4. CASHIER / CASH DRAWER
Remove PETTY CASH completely.

All cash movements belong to the drawer:
Opening Cash
+ Cash Sales/Receipts
- Cash Expenses
- Cash Refunds
± Other approved cash movements
= Expected Cash

Cashier workflow:
Open Drawer → enter opening cash → operate → Close Drawer.

At close, cashier ONLY enters physical denomination counts:
5000 × [count]
2000 × [count]
1000 × [count]
500 × [count]
100 × [count]
50 × [count]
20 × [count]
10 × [count]
5 × [count]
etc. as applicable.

System calculates:
Physical Cash Total
Expected Cash
Variance

CRITICAL:
Before drawer closure, the cashier MUST NOT see the variance amount.
Do not expose expected-vs-actual difference to the cashier.

After successful close, show a printable closure preview containing the relevant totals and variance.

Manager/Main Admin can see the full reconciliation and variance.

5. LOCATION EDIT
Remove “Add Stock” from the Location/Branch edit page.
Stock must be managed through the proper Inventory/Stock flows.

6. BRANCH CONTEXT
Every branch-specific feature/page must clearly display the current branch/location name at the top:
Cashier, Kitchen, Inventory, Transfers, Approvals, Orders, etc.

7. TRANSFERS
Remove the “From Storage → To Storage” UI/flow.
Transfers should be branch/location based only where applicable.

8. ITEM SELECTION
Wherever items are selected, add a fast search option.
Especially inventory, transfers, production, recipes, etc.

9. APPROVALS
Add “Force Approve” capability for Main Admin.

Main Admin can approve/reject their own requests when required.

Also add:
Approvals → Approval Access/Permissions

Main Admin can choose which staff members are allowed to approve requests for each location/branch.

Approval permission must be location-aware and enforced by backend RBAC.

Every approval request must have:
View Details
Approve
Reject
Status
Requested By
Branch/Location
Date/Time
Reason
Related record
Audit history

Before approving/rejecting, user must be able to open and inspect the complete request details.

Add filters:
Date range
Status
Request type
Requested by
From Location
To Location

Location filtering must work both directions:
From = Kandy → show requests originating from Kandy.
To = Jaffna → show requests going to Jaffna.
Support combinations such as From Kandy → To Jaffna.

10. KITCHEN PRODUCTION — SIMPLE FLOW

Create a very simple “Make an Item” flow.

MAKE AN ITEM
→ Select existing stock/inventory item OR enter a new prepared item name
→ Search items
→ Enter output quantity
→ Add ingredients
→ Ingredient selected from existing stock
→ Unit + quantity + unit cost shown/calculated
→ Optional notes/details
→ Cost Preview
→ Create Prepared Item

Do not make unnecessary fields mandatory.

After creation:
Prepared Items tab
→ Search
→ Filter/dropdown
→ Click item
→ View ingredient details, quantities, costs, recipe/production history
→ Enter actual quantity produced
→ Mark Done

When production is completed:
- Deduct consumed ingredients through the existing Inventory Ledger.
- Add the produced quantity into Inventory/Stock under the same prepared item.
- Calculate actual production cost using the existing authoritative costing/WAC logic.
- Production must be an inventory transformation, NOT immediate COGS.
- When that prepared item is later used in a food recipe and consumed by a sold order, its cost must automatically flow into COGS, profit and all relevant reports.

Inventory can receive stock from:
1. Purchasing
2. Production

Both must use the existing inventory ledger and accounting/audit system.

Every financial/inventory-affecting production transaction must have a unique Journal/Reference Number.

Production completion must be atomic, idempotent, audited and branch/tenant isolated.

11. SHIFT HANDOVER — PERFECT FLOW

Show complete Shift Handover history.

Flow:
Current Staff → Start Handover → Select Receiving Staff → Review Handover Details → Confirm Handover.

Show:
Outgoing Staff
Receiving Staff
Branch
Shift
Opening Cash
Cash activity
Orders/transactions
Relevant responsibilities
Outstanding tasks
Handover notes
Date/time
Status

Both users and authorized managers should be able to see the correct handover history according to permissions.

Prevent invalid/self handovers where inappropriate.
Prevent duplicate/conflicting active handovers.
Record confirmation and complete audit history.

12. GENERAL RULES

- Reuse existing billing, payment, inventory, COGS, accounting, approval, RBAC, branch, audit and reporting engines.
- No duplicate calculations.
- Backend is authoritative for financial/inventory calculations.
- Preserve Decimal/minor-unit money handling.
- Strict tenant and branch isolation.
- No real payment gateway or bank API.
- No silent financial/inventory changes.
- Use transactions, locking and idempotency where required.
- Keep UI simple and easy for staff.
- Avoid unnecessary buttons, fields, settings and complexity.
- Add helpful tooltips only where needed.
- Preserve existing design system.
- Add/modify tests for every changed workflow.

FINAL PROCESS:
Inspect → Identify existing logic → Implement → Test → Regression test → Fix issues → Final audit.

Do NOT blindly rebuild the application.