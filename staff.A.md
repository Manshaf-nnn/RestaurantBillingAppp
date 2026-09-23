TABLEFLOW — ROLE & ACCESS + STAFF + POS/CASHIER MASTER PROMPT

First inspect the existing Role, Permission, Staff, User/Auth, Branch, POS, Cashier, Cash Drawer, Opening Float and RBAC systems. Reuse existing architecture. Do not create duplicate systems.

Build a simple, secure, production-ready Role & Access system.

1. ROLES

Owner/Main Admin can create/edit/deactivate custom roles such as:

- POS
- Stock Keeper
- Waiter
- Kitchen Staff
- Accountant
- Manager
- Custom roles

Each role has default permissions grouped by module/action.

Example:
Stock Keeper:
✓ View Inventory
✓ Add Stock
✓ Edit Stock
✓ Stock Count
✗ Approve Transfers

Roles are permission templates, not individual accounts.

2. STAFF

Each staff member has their OWN login credentials.

Staff fields:
- Name
- Staff Code
- Login credential
- Role
- Branch/location
- Phone/email if needed
- Active/inactive

Staff Code must be unique and automatically generated.

Example:

John → Stock Keeper → Ampara
David → Stock Keeper → Ampara
Ahmed → Stock Keeper → Kandy

All can use the same Stock Keeper role but have separate accounts.

3. INDIVIDUAL PERMISSION OVERRIDES

Staff inherit their role permissions by default.

Owner can override permissions for individual staff without creating another role.

Example:

Stock Keeper default:
✓ Edit Stock

John:
✓ Edit Stock

David:
✗ Edit Stock

Ahmed:
✓ Edit Stock
✓ Export Inventory

Support:
- ALLOW override
- DENY override

Explicit staff DENY overrides role permission.

Final access must be calculated automatically and shown as:

Inherited from Role
+ Staff Overrides
= Effective Access

Owner should easily see exactly what each staff member can access.

4. BRANCH ACCESS

Role permissions and branch access are separate.

Example:
John → Stock Keeper → Ampara only
David → Stock Keeper → Kandy only

Backend must enforce branch isolation. Never rely only on hiding UI.

5. STAFF LOGIN

After login:

User
→ Staff
→ Role
→ Role Permissions
→ Staff Overrides
→ Branch Access
→ Final Effective Permissions

The staff member should only see/access the modules and actions they are authorized for.

Direct URL/API access must also be blocked server-side.

6. POS / CASHIER

Cashier is now merged into POS.

DO NOT create a separate Cashier workspace.

Create/use:

POS role

POS may include:
- Create orders
- Edit orders
- Payments
- Split payments
- Discounts
- Customers
- Loyalty
- Cash Drawer
- Opening Float

Use granular permissions.

IMPORTANT:

Only users with the specific permission:

POS_OPEN_DRAWER

can see/use:

- Open Cash Drawer
- Opening Float
- Cashier opening workflow

Stock Keeper, Waiter, Kitchen, Accountant etc. must NOT see this option unless explicitly granted.

A POS user without POS_OPEN_DRAWER must also be blocked server-side.

7. POS WORKSPACE

After login, POS staff should see only their authorized POS workspace.

Example:

POS + Cash Drawer user:
Dashboard
POS
Orders
Customers
Loyalty
Cash Drawer
Notifications

Stock Keeper:
Dashboard
Inventory
Stock Count
Transfers
Notifications

Do not show unauthorized modules.

8. OWNER ROLE & ACCESS UI

Keep it simple:

ROLE & ACCESS
[Roles] [Staff]

Role card:
Stock Keeper
3 Staff
14 Permissions

Staff card:
John
Stock Keeper
Ampara
Active
View Effective Access

Staff permission page should clearly show:

ROLE DEFAULT PERMISSIONS
✓ View Inventory
✓ Edit Stock

INDIVIDUAL OVERRIDES
✗ Edit Stock
✓ Export Inventory

FINAL EFFECTIVE ACCESS
✓ View Inventory
✗ Edit Stock
✓ Export Inventory

9. SECURITY

All permissions must be enforced server-side.

Protect against:
- Cross-tenant access
- Cross-branch access
- Unauthorized API access
- Direct URL access
- Self-granting permissions
- Privilege escalation

Disabled staff cannot log in.

Do not delete staff/roles if historical records depend on them.

10. CASHIER MIGRATION

Since Cashier is now part of POS:

Safely migrate existing Cashier users to POS while preserving their current access.

Do not break existing users.

Use the existing Cash Drawer, Shift and Opening Float systems.

11. DATABASE

Inspect existing schema first.

Reuse existing User/Staff/Role/Permission models where possible.

Only create necessary migrations.

Do not duplicate RBAC, authentication, POS or Cashier systems.

12. TEST EVERYTHING

Test:

- Multiple staff using same role
- Individual ALLOW/DENY overrides
- Login with separate credentials
- Effective permissions
- Branch isolation
- Direct URL/API authorization
- Disabled staff
- POS permissions
- POS_OPEN_DRAWER
- Opening Float visibility
- Existing Cashier → POS migration
- Role changes
- Permission changes
- No privilege escalation

Run typecheck, lint, tests and production build.

MOST IMPORTANT:

Inspect first → reuse existing logic → implement → migrate safely → test.

Do not only hide buttons in the UI. The backend must enforce the exact same permissions.

Do not break existing financial, inventory, accounting, payment, shift, cash drawer or audit history.