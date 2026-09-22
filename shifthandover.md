TABLEFLOW — REBUILD SHIFT MANAGEMENT & HANDOVER

First inspect the existing Shift Handover, Staff, RBAC, Branch, POS, Cash Drawer, Orders, Tasks and Audit systems. Reuse existing logic; do not create duplicate systems.

Rebuild Shift Management as 4 connected parts:

1. SHIFT TEMPLATES
Main Admin/Owner can create customizable shifts such as Day, Night, Morning or any custom shift.
Set:
- Shift name
- Start/end time
- Applicable roles
- Branch
- Active/inactive

2. SHIFT ASSIGNMENT
Main Admin and authorized Branch Managers can assign staff to shifts.
Assignment includes:
- Staff
- Role
- Branch
- Date
- Shift
- Scheduled start/end time

Branch Managers can only manage their own branch.

3. START / ACTIVE SHIFT
When staff logs in/starts work, show their assigned shifts and require them to select the shift they are working.
Record:
- Staff
- Role
- Branch
- Shift
- Scheduled time
- Actual start/end time
- Shift session

All records must be branch-isolated and auditable.

4. SHIFT HANDOVER
Before handing over, show a clean summary of everything relevant:
- Cash drawer
- Opening cash
- Cash sales/payments
- Refunds/approved cash movements
- Orders/transactions
- Pending orders
- Pending tasks
- Inventory responsibilities
- Pending transfers/receiving if applicable
- Important notes/issues
- Other active responsibilities

Outgoing staff reviews and submits the handover.
Receiving staff reviews and explicitly ACCEPTS or REJECTS it.
Rejection requires a reason.

CASH DRAWER — CRITICAL:
Use the existing Cash Drawer as the single source of truth.
Each cashier shift must have its own branch-specific drawer/session.
At shift close, cashier enters physical denomination counts.
System calculates actual cash and expected cash.
DO NOT show the cashier the variance before the drawer is submitted/closed.
After closure, show the final reconciliation and variance.
Manager/Main Admin can view the complete reconciliation.
Never overwrite historical cash records.

HANDOVER:
Outgoing staff → Review → Confirm → Pending Acceptance → Receiving Staff Review → Accept/Reject → Completed.

Do not rewrite historical orders, payments, inventory or cash records after handover. Handover transfers responsibility, not historical ownership.

UI:
Keep the Shift tab extremely clean and simple.
Show:
- Current Shift
- Assigned Staff
- Start/End Time
- Shift Status
- Cash Drawer Status
- Handover Status
- Pending Responsibilities

Add searchable/filterable Shift History and Handover History.

Admin must be able to export shift assignments, attendance/session records, cash reconciliation and handover history using date/branch/staff/shift filters.

Enforce:
- RBAC
- Branch isolation
- No self-handover
- No duplicate active shift/session
- No unauthorized cross-branch access
- Full audit trail
- Server-side validation
- Duplicate-safe transactions

Use the existing TableFlow design system.

Inspect → plan → implement → test the complete flow, especially cash drawer, branch isolation, shift assignment, handover and concurrent actions.