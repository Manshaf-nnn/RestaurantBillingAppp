Implement and fix the existing Cash Drawer, Petty Cash, Cashier Session, Shift Handover, Branch Isolation, Reports, and Role Permission system. First inspect the existing code and architecture. Do not recreate working functionality unnecessarily. Extend and fix the existing system properly with actual database, backend, API, authorization, calculation, and report logic. Do not only make UI changes.

CORE CASHIER LOGIN FLOW

A Cashier must not directly access the full dashboard immediately after login.

The flow must be:

Cashier opens secure login link
→ Login successful
→ Start/Resume Cashier Session screen
→ Select Cashier Name
→ Select authorized Branch
→ Select Register / Cash Drawer / Location
→ Enter Opening Cash / Cash Float
→ Enter or confirm Opening Petty Cash Fund
→ Confirm and open session
→ Cash Drawer Session is created
→ Cashier can access the full permitted dashboard

If the Cashier already has an active valid session, do not create a duplicate session. Show options to Resume Active Session or View Current Session.

START CASHIER SESSION SCREEN

Immediately after login, show a dedicated Start Cashier Session screen.

Fields:

1. Cashier Name
Show only valid active cashier staff.

2. Branch
Show only branches the logged-in Cashier is authorized to access. A normal Cashier must never select or access another branch.

3. Register / Cash Drawer / Location
After selecting the branch, show only registers or locations belonging to that branch.

4. Opening Cash / Cash Float
The Cashier enters the physical cash available in the drawer at the beginning of the shift.

5. Opening Petty Cash Fund
Show the current petty cash balance or allow the Cashier to enter or confirm the petty cash fund received for the shift.

Important:
Opening Cash and Opening Petty Cash are separate values and must not be confused.

Before opening the session, show a confirmation summary with:
- Cashier
- Branch
- Register
- Opening Cash
- Opening Petty Cash

CASH DRAWER SESSION LOGIC

When the Cashier confirms, create a unique Cash Drawer Session.

Store:
- Session ID
- Branch ID
- Register/Location ID
- Cashier/Staff ID
- Opening date and time
- Opening Cash
- Opening Petty Cash Fund
- Session Status
- Created By

Example:
Session ID: CD-2026-000123
Branch: Branch 01
Register: Counter 01
Cashier: John
Opening Cash: Rs. 10,000
Opening Petty Cash: Rs. 5,000
Status: OPEN

Do not allow conflicting duplicate active sessions for the same Branch + Register/Cash Drawer unless the system intentionally supports multiple independent drawers.

CASHIER DASHBOARD

After opening or resuming a valid session, the Cashier can access their permitted dashboard.

Recommended Cashier features:
- Dashboard
- POS / Orders
- Active Orders
- Tables
- Reservations
- Payments
- Cash Drawer
- Petty Cash
- Cash In / Cash Out
- Things To Do
- Shift Handover
- Order History
- My Shift / Current Session
- Logout

The Owner/Admin controls which features are enabled through the existing role and permission system.

If a feature is disabled:
- Do not show it in the sidebar
- Do not allow access through a direct URL
- Do not allow API or backend access

CASH DRAWER TRANSACTION LOGIC

Every physical cash movement during an active session must create a permanent transaction record.

Never directly change the drawer balance without recording a transaction.

Cash In transaction types may include:
- Opening Float
- Cash Sales
- Additional Cash
- Approved Cash Adjustment

Cash Out transaction types may include:
- Petty Cash Expense
- Cash Refund
- Cash Paid Out
- Cash Drop
- Bank Deposit
- Approved Adjustment

Every transaction must store:
- Transaction ID
- Branch ID
- Register/Location ID
- Cash Drawer Session ID
- Transaction Type
- Amount
- Date and Time
- Description
- Reference Number
- Created By
- Approved By where required

AUTOMATIC CASH SALES

When a customer completes an order using Cash payment, automatically add the amount to the active Cash Drawer Session.

Example:

Opening Cash: Rs. 10,000
Cash Sale #001: +Rs. 2,500
Cash Sale #002: +Rs. 4,000
Expected Cash: Rs. 16,500

Card payments, bank transfers, online payments, QR payments, and other non-cash payments must not increase physical drawer cash.

However, non-cash payments should still appear in the session summary and reports.

PETTY CASH LOGIC

Petty Cash must be managed as a controlled fund for small business expenses.

Examples:
- Emergency ingredient purchases
- Cleaning supplies
- Transport
- Small repairs
- Printing
- Other approved minor expenses

A Petty Cash request should include:
- Branch
- Expense Category
- Description
- Amount
- Date
- Requested By
- Receipt/Invoice/Reference
- Approval Status
- Approved By

Use this status flow:

DRAFT
→ REQUESTED
→ PENDING APPROVAL
→ APPROVED
→ PAID
→ RECORDED

Also support REJECTED where applicable.

Only an approved and paid petty cash transaction should reduce the actual available petty cash or physical cash balance.

The transaction must appear in:
- Petty Cash Ledger
- Cash Drawer Session
- Expense Records
- Relevant Branch Financial Records

IMPORTANT PETTY CASH RULE

Keep these completely separate:

Opening Petty Cash:
Money allocated or confirmed at the beginning of the shift. This establishes the petty cash fund available.

Petty Cash Expense:
Money actually spent during the shift. This reduces the available petty cash balance.

Do not combine these as one transaction type.

LIVE CASH DRAWER CALCULATION

The system must automatically calculate expected physical cash.

Formula:

Expected Physical Cash =
Opening Cash
+ Cash Sales
+ Additional Cash
+ Other Approved Cash In
- Cash Refunds
- Petty Cash Paid
- Cash Paid Out
- Cash Drops
- Bank Deposits
- Other Approved Cash Out

Example:

Opening Cash: Rs. 10,000
+ Cash Sales: Rs. 50,000
+ Additional Cash: Rs. 2,000
- Cash Refunds: Rs. 1,000
- Petty Cash Paid: Rs. 3,000
- Cash Drop: Rs. 20,000

Expected Physical Cash: Rs. 38,000

The system-calculated expected balance must not be manually editable.

CASH DRAWER CLOSING FLOW

At the end of the shift, the Cashier selects Close Cash Drawer / End Shift.

Show a complete summary:
- Opening Cash
- Total Cash Sales
- Total Non-Cash Payments
- Cash In
- Cash Out
- Cash Refunds
- Petty Cash Expenses
- Cash Drops
- Expected Closing Cash

The Cashier must physically count the actual cash and enter:

Actual Closing Cash: Rs. ______

Calculate:

Variance = Actual Closing Cash - Expected Closing Cash

Example:
Expected: Rs. 38,000
Actual: Rs. 37,500
Result: Cash Short Rs. 500

If actual cash is higher, show Cash Over.

Require a reason for any variance.

Use the following professional status flow:

OPEN
→ CLOSING REQUESTED
→ COUNTED
→ PENDING REVIEW
→ CLOSED

For zero variance or a variance within the Owner's configured allowed limit, the system may close automatically.

For a significant variance:
PENDING REVIEW
→ Manager/Owner Review
→ APPROVED or CORRECTION REQUIRED

CLOSED DRAWER HISTORY

Closed drawer records must never disappear or be deleted.

Create a permanent Cash Drawer History / Closed Sessions section.

Each record must show:
- Session ID
- Branch
- Register
- Cashier
- Opening Date/Time
- Closing Date/Time
- Opening Cash
- Cash Sales
- Non-Cash Payment Summary
- Cash In
- Cash Out
- Petty Cash Expenses
- Refunds
- Cash Drops
- Expected Closing Cash
- Actual Closing Cash
- Variance
- Status
- Closing Notes
- Reviewed By

Every closed session must have a View Details option showing the complete transaction history and calculations.

SHIFT HANDOVER

If an active Cash Drawer is handed over to another Cashier, use this controlled workflow:

Current Cashier
→ Counts current physical cash
→ Enters handover amount
→ Select next authorized Cashier
→ Next Cashier confirms receipt
→ Handover record is created
→ Session continues or responsibility changes according to the existing session model

Store:
- From Cashier
- To Cashier
- Branch
- Register
- Expected Amount
- Actual Amount
- Variance
- Date/Time
- Notes

Do not allow handovers between branches.

CASH DRAWER AND PETTY CASH REPORTS

Create a professional Reports section for Cash Drawer and Petty Cash.

All reports must support filters for:
- Branch
- Cashier
- Register / Location
- Date Range
- Status
- Transaction Type

Provide quick date filters:
- Today
- Yesterday
- This Week
- Last Week
- This Month
- Last Month
- Custom Date Range

Custom Date Range:

From: [Date]
To: [Date]
Apply Filters

Reports must display only records that fall within the selected date range.

CASH DRAWER REPORT

Show summary totals for the selected filters:
- Total Opening Cash
- Total Cash Sales
- Total Non-Cash Payments
- Total Cash In
- Total Cash Out
- Total Petty Cash Expenses
- Total Refunds
- Total Cash Drops
- Total Expected Closing Cash
- Total Actual Closing Cash
- Total Cash Short
- Total Cash Over
- Number of Open Sessions
- Number of Closed Sessions

Also show a detailed Cash Drawer Session list.

Every row must have View Session Details.

PETTY CASH REPORT

Show:
- Opening Petty Cash Balance
- Total Petty Cash Allocated
- Total Petty Cash Expenses
- Remaining Petty Cash Balance
- Pending Requests
- Approved Requests
- Rejected Requests
- Paid Requests

Detailed transactions must show:
- Date
- Branch
- Category
- Description
- Amount
- Requested By
- Approved By
- Status
- Receipt/Reference

REPORT EXPORT AND PRINT

Add:
- Print Report
- Export PDF
- Export Excel/CSV where supported

Exported and printed reports must respect the currently selected:
Branch + Date Range + Cashier + Register + Status + Transaction Type.

Do not export unfiltered data when filters are active.

All report totals must come from actual saved database transactions and sessions, not temporary frontend calculations.

STRICT BRANCH ISOLATION

Every Cash Drawer, Petty Cash, Cash Transaction, Shift Handover, and Report record must belong to the correct branch.

Correct structure:

Branch
→ Location / Register
→ Cash Drawer Session
→ Cash Transactions

Every relevant record must correctly store:
- branch_id
- location_id or register_id
- cash_drawer_session_id
- staff_id

Isolation rules:

A Cashier assigned to Branch 01 can only see:
- Branch 01 Cash Drawer
- Branch 01 Petty Cash
- Branch 01 Transactions
- Branch 01 Reports
- Authorized Branch 01 sessions

They must never see Main Branch or another branch's records.

A Branch Manager can only see their assigned branch.

The Owner/Admin can select any branch through the authorized Admin branch selector and view that branch's records.

Only the Owner/Admin should have cross-branch visibility where explicitly authorized.

Do not rely only on frontend filtering. Enforce branch isolation in backend APIs, server-side authorization, and database queries.

SECURITY

Validate all permissions and branch access in:
- Frontend
- Backend
- API routes
- Server-side authorization
- Database queries

A Cashier must not be able to access another branch by:
- Changing the URL
- Changing branch_id
- Modifying API requests
- Using another branch's session ID

Reject all unauthorized access.

OWNER / ADMIN CONTROL

The Owner/Admin should be able to:
- View all authorized Cash Drawer Sessions
- Select any branch
- View open drawers
- View closed drawer history
- Review drawer details
- Review cash variances
- Approve or reject adjustments
- View petty cash records
- Approve or reject petty cash requests
- Configure variance limits
- Configure petty cash approval rules
- View reports with all filters and date range selection
- Print reports
- Export reports

Branch Managers should only manage their assigned branch.

Cashiers should only access their authorized branch and permitted sessions.

REQUIRED TESTING

Before completing the implementation, test:

1. Cashier cannot access the full dashboard before starting or resuming a valid session.
2. Cashier can select only authorized branches.
3. Register/Location shows only for the selected branch.
4. Opening Cash and Opening Petty Cash are recorded separately.
5. A unique session is created successfully.
6. Duplicate active sessions are prevented.
7. Cash sales automatically increase expected physical cash.
8. Card and other non-cash payments do not increase physical drawer cash.
9. Refunds reduce expected cash.
10. Petty Cash expenses follow approval rules.
11. Every cash movement creates a permanent transaction record.
12. Expected Closing Cash is calculated correctly.
13. Actual Cash can be entered after physical counting.
14. Variance is calculated correctly.
15. Variance reason is required.
16. Significant variances go for review.
17. Closed drawer records remain permanently available.
18. Today, Week, Month, and Custom Date Range reports work correctly.
19. Branch, Cashier, Register, Status, and Transaction Type filters work correctly.
20. Report totals match actual saved transactions.
21. Print and export respect all selected filters.
22. Branch 01 records never appear in Main Branch.
23. Branch 02 records never appear in Branch 01.
24. Petty Cash remains strictly branch-specific.
25. Shift Handovers cannot cross branches.
26. Unauthorized users cannot access another branch by changing URLs or API data.
27. Owner/Admin can correctly select and review each branch.

FINAL BUSINESS RULE

A Cashier must start or resume a valid Cash Drawer Session immediately after login before accessing the full operational dashboard. The Cashier selects their authorized identity, branch, register/location, Opening Cash, and Opening Petty Cash Fund. Every cash movement must be permanently recorded against the correct Branch, Register, Cashier, and Cash Drawer Session. Cash sales increase expected physical cash, while refunds, petty cash expenses, cash-outs, and drops reduce it. At closing, the system compares expected cash with actual counted cash and records any variance. All closed sessions must remain permanently available. Professional Cash Drawer and Petty Cash reports must support Branch, Cashier, Register, Status, Transaction Type, and Date Range filtering. All branch data must remain strictly isolated, while the Shop Owner/Admin can review each branch through the authorized Admin branch selector.

Implement the actual database logic, backend validation, transaction records, session management, calculations, reports, date filtering, export/print functionality, permissions, and branch isolation. Do not only create the UI.