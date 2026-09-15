TABLEFLOW — SENIOR QA, BUG HUNT & PRODUCTION HARDENING

IMPORTANT: YOU ARE NOW ACTING AS A SENIOR SOFTWARE TESTER, QA ENGINEER, SECURITY AUDITOR AND SENIOR BUG-FIXING DEVELOPER.

Your job is to find and fix bugs across the ENTIRE TableFlow system.

DO NOT START CHANGING CODE IMMEDIATELY.

==================================================
PHASE 1 — FULL SYSTEM AUDIT
==================================================

First inspect the entire project.

Understand:

- Architecture
- Database schema and relationships
- Multi-tenant structure
- Restaurant/branch isolation
- Authentication
- RBAC/permissions
- POS
- Orders
- QR ordering
- KDS
- Waiter
- Billing
- Payments
- Refunds
- Discounts
- Inventory
- Inventory ledger
- Purchasing
- Suppliers
- Recipes
- Prepared production
- COGS
- Customers
- Loyalty
- Reservations
- Accounting
- Reports
- Reconciliation
- Printing
- Realtime
- PWA
- Super Admin
- Audit logs
- Background jobs
- APIs
- Website integrations
- Settings

Read the existing tests and documentation before modifying important logic.

DO NOT blindly rebuild existing functionality.

DO NOT create duplicate systems.

DO NOT change working business logic unless a real bug requires it.

==================================================
PHASE 2 — FIND BUGS
==================================================

Actively search for:

1. Functional bugs
2. Logic bugs
3. Database bugs
4. Financial/accounting bugs
5. Inventory bugs
6. COGS bugs
7. Payment/refund bugs
8. Permission/RBAC bugs
9. Multi-tenant isolation bugs
10. Branch isolation bugs
11. Security vulnerabilities
12. Race conditions
13. Duplicate transaction bugs
14. Idempotency problems
15. Realtime bugs
16. PWA/offline problems
17. API bugs
18. Validation problems
19. UI/UX bugs
20. Printing/receipt bugs
21. Report calculation differences
22. Timezone/date problems
23. Performance problems
24. Error-handling problems
25. Data-integrity problems
26. Migration/deployment problems
27. Edge cases

Do not only test the happy path.

Try to BREAK the system intentionally.

==================================================
PHASE 3 — FINANCIAL SAFETY
==================================================

Give special attention to:

Billing
→ Payment
→ Refund
→ Inventory
→ COGS
→ Accounting
→ Reconciliation
→ Reports

Verify that there is ONE authoritative calculation for each important financial concept.

Check:

- Decimal/minor-unit accuracy
- Discounts
- Coupons
- Tax
- Service charge
- Rounding
- Partial payments
- Split payments
- Overpayments
- Outstanding balance
- Refunds
- Cancelled orders
- Cancelled lines
- Payment duplication
- Payment races
- Inventory depletion
- Recipe costing
- WAC
- COGS
- Waste
- Stock adjustments
- Stock transfers
- Accounting entries
- Daily close
- Reconciliation

Never allow a UI calculation to disagree with the backend.

Never allow silent financial changes.

==================================================
PHASE 4 — SECURITY
==================================================

Test whether a user can access data they should not have access to.

Test:

- Restaurant A → Restaurant B access
- Branch A → Branch B access
- Unauthorized API requests
- Permission bypass
- Direct API manipulation
- ID manipulation
- Privilege escalation
- Unauthorized approvals
- Unauthorized refunds
- Unauthorized discounts
- Unauthorized stock adjustments
- Sensitive data exposure
- Secret/API-key exposure
- Authentication weaknesses
- Rate limiting

Backend authorization must always be enforced.

Never rely only on hiding UI buttons.

==================================================
PHASE 5 — DATABASE & CONCURRENCY
==================================================

Look for:

- Missing constraints
- Incorrect relationships
- Unsafe migrations
- Race conditions
- Duplicate records
- Lost updates
- Incorrect transactions
- Missing row locks
- N+1 queries
- Unbounded queries
- Missing indexes
- Unsafe deletes
- Orphan records

Test simultaneous actions such as:

Two cashiers paying the same order.

Two staff members completing the same production job.

Two users approving the same request.

Two users modifying the same stock.

Two requests creating the same order.

The result must remain correct and idempotent.

==================================================
PHASE 6 — TESTING
==================================================

Run the existing test suite.

Then add tests for every real bug discovered.

Create tests for:

- Unit logic
- API
- Database
- Permissions
- Multi-tenancy
- Branch isolation
- Financial calculations
- Inventory
- COGS
- Payments
- Refunds
- Reconciliation
- End-to-end workflows

Do not delete or weaken existing tests just to make the suite pass.

==================================================
PHASE 7 — BUG FIXING
==================================================

For every bug:

1. Reproduce it.
2. Identify the root cause.
3. Create a regression test.
4. Fix the root cause.
5. Run related tests.
6. Run the full test suite.
7. Check that existing functionality was not broken.

Prefer small, safe fixes.

Do not rewrite large parts of the system unnecessarily.

==================================================
PHASE 8 — PRODUCTION SAFETY
==================================================

Do NOT:

- Modify production data directly.
- Delete financial history.
- Delete audit logs.
- Use destructive database commands.
- Disable security checks.
- Disable tests.
- Change financial rules without evidence.
- Push directly to main if the project workflow uses branches.
- Deploy untested changes.

Use proper migrations for database changes.

Preserve existing data and historical records.

==================================================
PHASE 9 — FINAL AUDIT
==================================================

After fixing bugs, run the complete system again.

Verify the complete flow:

Purchase
→ Inventory
→ Recipe
→ Order
→ KDS
→ COGS
→ Bill
→ Payment
→ Refund if applicable
→ Accounting
→ Daily Close
→ Reports
→ Reconciliation

Also verify:

Restaurant A
cannot access Restaurant B.

Branch A
cannot access Branch B unless authorized.

==================================================
FINAL REPORT
==================================================

At the end, give me a clear report:

TOTAL BUGS FOUND:
TOTAL BUGS FIXED:
TOTAL TESTS ADDED:
TOTAL TESTS PASSED:
TOTAL TESTS FAILED:

CRITICAL BUGS:
- ...

HIGH BUGS:
- ...

MEDIUM BUGS:
- ...

LOW BUGS:
- ...

SECURITY ISSUES:
- ...

DATABASE ISSUES:
- ...

FINANCIAL ISSUES:
- ...

PERFORMANCE ISSUES:
- ...

REMAINING RISKS:
- ...

FILES CHANGED:
- ...

MIGRATIONS CREATED:
- ...

IMPORTANT:

Do not claim the system is bug-free simply because tests pass.

If you find something that cannot safely be fixed without changing an existing business rule, STOP and explain the issue before changing it.

Your priority is:

1. Financial correctness
2. Data integrity
3. Security
4. Tenant/branch isolation
5. Reliability
6. Performance
7. User experience

FIRST AUDIT.
THEN REPRODUCE.
THEN FIX ROOT CAUSES.
THEN TEST.
THEN REPORT.