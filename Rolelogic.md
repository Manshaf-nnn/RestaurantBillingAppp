# Role-Based Share Links, Custom Roles & Feature Access Control

Improve the existing **Share Links** tab and convert it into a complete **Role-Based Access Control system** for the restaurant POS.

First inspect the existing Share Links, authentication, roles, permissions, branch isolation, and sidebar logic. **Do not recreate features that already work. Extend and fix the existing system properly.**

## CORE LOGIC

The Shop Owner/Admin should be able to:

1. Create predefined or custom roles.
2. Give the role any name.
3. Select the branch for the role.
4. See **all available system features** while creating the role.
5. Enable or disable each feature.
6. Configure what actions the role can perform.
7. Create login credentials using email and login code.
8. Generate a separate secure link for the role/staff.
9. The staff member logs in through that link.
10. After login, they see only the enabled features in their sidebar.

The Owner has full control over what every role can access.

---

# 1. PREDEFINED AND CUSTOM ROLES

Keep useful predefined roles such as:

* Cashier
* Waiter
* Kitchen Staff
* Restaurant Manager
* Stock Keeper
* Purchasing Operator
* Supervisor
* Accountant

Also add:

## + Create Custom Role

The Owner/Admin can create any role, for example:

* Stock Controller
* Store Assistant
* Finance Officer
* Delivery Coordinator

The role name must not be hard-coded.

---

# 2. ROLE CREATION FLOW

When creating a role, the Admin should complete:

### Basic Information

* Role Name
* Description
* Assigned Branch
* Staff/User Name if applicable
* Login Email
* Login Code

Then show **all available features in the system**.

The Admin can turn each feature ON or OFF.

Example:

```text id="pmu5rf"
Dashboard                  ON/OFF
Orders                     ON/OFF
Tables                     ON/OFF
Reservations               ON/OFF
Kitchen / KDS              ON/OFF
Cash Drawer                ON/OFF
Payments                   ON/OFF
Things To Do               ON/OFF
Shift Handover             ON/OFF
Inventory                  ON/OFF
Stock Ledger               ON/OFF
Low Stock                  ON/OFF
Purchase Orders            ON/OFF
Purchase / GRN             ON/OFF
Suppliers                  ON/OFF
Stock Transfers            ON/OFF
Wastage                    ON/OFF
Reports                    ON/OFF
Staff                      ON/OFF
Expenses                   ON/OFF
Settings                   ON/OFF
Approvals                  ON/OFF
```

Only enabled features should appear in that role's sidebar.

---

# 3. FEATURE ACTION PERMISSIONS

For every enabled feature, allow the Admin to control what the user can do.

Example:

```text id="9x7ayz"
Inventory

View        ON/OFF
Create      ON/OFF
Edit        ON/OFF
Delete      ON/OFF
Approve     ON/OFF
```

Use relevant permissions where applicable:

* View
* Create
* Edit
* Delete
* Approve
* Reject
* Cancel
* Submit
* Transfer
* Receive
* Export
* Print

Example:

A Stock Keeper may have:

```text id="3s6i0b"
Inventory          View + Edit
Stock Ledger       View only
GRN                View + Receive
Stock Transfers    Create + View
Reports            View only
```

---

# 4. ROLE-SPECIFIC SIDEBAR

The sidebar must be generated dynamically based on the role's enabled features.

Do NOT show the full Admin sidebar and only block access after clicking.

Example:

## CASHIER

Suggested features:

* Dashboard
* Orders / POS
* Tables
* Reservations
* Cash Drawer
* Payments
* Things To Do
* Shift Handover
* Order History
* Customer Search

Everything else should be hidden unless the Owner enables it.

---

## WAITER

Suggested features:

* Dashboard
* Tables
* Orders
* Reservations
* Order Status
* Served Items
* Customer Requests
* Things To Do
* Shift Handover

---

## KITCHEN STAFF

Suggested features:

* Kitchen Dashboard
* Active Orders
* Order Queue
* Ready Orders
* Completed Orders
* Things To Do
* Shift Handover

Kitchen staff should only see orders from their assigned branch.

---

## STOCK KEEPER

Suggested features:

* Inventory
* Stock Levels
* Stock Ledger
* Low Stock
* GRN / Receiving
* Stock Transfers
* Wastage
* Stock Count
* Things To Do

---

## PURCHASING OPERATOR

Suggested features:

* Purchase Orders
* Purchase Requests
* Suppliers
* Purchase / GRN
* Purchase History
* Things To Do

The Owner decides whether this role can approve purchases or only submit them for approval.

---

## RESTAURANT MANAGER

Suggested features:

* Dashboard
* Orders
* Tables
* Reservations
* Staff
* Shifts
* Cash Drawer
* Inventory Overview
* Branch Reports
* Things To Do
* Shift Handover

The Manager must still only access their assigned branch.

---

# 5. SECURE SHARE LINK & LOGIN

After creating the role/user, the system should generate a separate secure access link.

The record should include:

* Role
* Branch
* User/Staff Name
* Login Email
* Login Code
* Active/Inactive Status
* Created Date
* Last Login

The Owner should be able to:

* Copy the link
* Regenerate the link
* Regenerate the login code
* Disable the link
* Revoke access

The link should use a secure unique token and must not be predictable.

---

# 6. LOGIN FLOW

The flow should be:

```text id="q6h69e"
Owner creates Role
        ↓
Assigns Branch
        ↓
Selects Features
        ↓
Sets Action Permissions
        ↓
Creates Login Email + Code
        ↓
System Generates Secure Link
        ↓
Owner Shares Link
        ↓
Staff Opens Link
        ↓
Enters Email + Login Code
        ↓
System Verifies Role + Branch + Permissions
        ↓
Staff Sees Limited Dashboard & Sidebar
```

---

# 7. BRANCH ISOLATION

Every role must respect the existing multi-branch isolation rules.

Example:

A Cashier assigned to **Branch 01** can access only:

* Branch 01 Orders
* Branch 01 Tables
* Branch 01 Reservations
* Branch 01 Cash Drawer
* Branch 01 Payments

They must not see Main Branch or another branch.

The backend must enforce:

```text id="wn7xkq"
User
+ Role
+ Assigned Branch
+ Enabled Feature
+ Allowed Action
```

The frontend must not be the only security layer.

---

# 8. SECURITY RULES

If a feature is disabled:

* Do not show it in the sidebar.
* Do not allow access through a direct URL.
* Do not allow access through the API.
* Do not allow access by manually changing branch IDs or request data.

All permissions must be checked in:

* Frontend
* Backend
* API routes
* Server-side authorization
* Database queries where applicable

---

# 9. OWNER CONTROL

The Shop Owner/Admin must have full control over roles and access.

The Owner can:

* Create roles
* Create custom roles
* Edit roles
* Delete/deactivate roles
* Enable/disable any feature
* Enable/disable individual actions
* Assign a role to a branch
* Create login credentials
* Generate secure links
* Regenerate links and login codes
* Revoke access
* Disable users
* View active/inactive users
* See last login
* Duplicate an existing role as a template

Changing a role's permissions should update the affected user's access immediately.

---

# FINAL RULE

> **Every staff member should have a simple workspace with only the features required for their job. The Shop Owner/Admin can create any role, see all available system features during role creation, enable or disable each feature, control individual actions, assign the role to a branch, and generate a separate secure link with login email and code.**

**Inspect the existing project first and implement this using the current architecture. Do not only create the UI. Properly connect the database, authentication, secure links, role permissions, action permissions, dynamic sidebars, backend authorization, API protection, and branch isolation.**
