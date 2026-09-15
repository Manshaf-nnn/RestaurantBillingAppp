TABLEFLOW — SIMPLE & SMART SIDEBAR NAVIGATION

First inspect the existing Restaurant Admin sidebar/navigation and all existing modules.

DO NOT blindly rebuild the sidebar.
Reuse the existing routes, permissions, RBAC and module structure.
Do not change existing functionality.

==================================================
1. FAVORITES
==================================================

There are many features in the Restaurant Admin panel.

Add a "Favorites" section at the top of the sidebar.

Each user should be able to mark any permitted page/module as a favorite.

Example:

★ Favorites
  Dashboard
  POS
  Inventory
  Sales Reports
  Cashier

The user can click a ★ / bookmark icon beside a menu item to add/remove it from Favorites.

Favorites must be saved per USER, not globally.

Example:

Owner A favorites:
POS
Inventory
Sales

Manager B favorites:
KDS
Orders
Staff

Each user sees their own favorites.

Only show modules the user has permission to access.

==================================================
2. FAVORITE ORDER
==================================================

Allow users to reorder their favorites using simple drag-and-drop.

The order should be saved automatically.

Example:

★ Favorites
1. POS
2. Inventory
3. Sales
4. Reports

Keep this optional and simple.

==================================================
3. RECENTLY USED
==================================================

Add a small "Recent" section below Favorites.

Automatically show the user's recently visited pages.

Example:

Recent
- POS
- Inventory
- Cash Reconciliation
- Sales Report

Keep only a small number of recent items.

Do not allow Recent to become a huge list.

==================================================
4. SIDEBAR SEARCH
==================================================

Add a simple search button/search field in the sidebar.

When the user types:

"inventory"

show permitted matching pages such as:

Inventory
Stock
Stock Transfers
Stock Counts
Wastage

Clicking a result should open that page immediately.

Search must respect RBAC and only show pages the user can access.

==================================================
5. SIDEBAR COLLAPSE
==================================================

If the existing design supports it, allow the sidebar to collapse.

Collapsed mode should show icons.

Expanded mode should show:

Icon + Feature Name

Do not introduce a complicated navigation redesign.

==================================================
6. IMPORTANT UX RULE
==================================================

The sidebar should remain clean.

Recommended structure:

★ Favorites
  POS
  Inventory
  Sales

Recent
  KDS
  Cashier

────────────

Main
Dashboard
Orders
POS
KDS
Inventory
Purchasing
Accounting
Reports
Customers
Staff
Settings
...

The full existing navigation remains available.

Favorites only provides a shortcut.

Do not hide existing modules because they are not favorited.

==================================================
7. PERMISSION & SECURITY
==================================================

Favorites and Recent must respect the existing:

- Authentication
- RBAC
- Restaurant isolation
- Branch permissions

If a user's permission is removed, that module must automatically disappear from their Favorites/Recent and must not be accessible through the saved shortcut.

Do not create a second permission system.

==================================================
8. RESPONSIVE / MOBILE
==================================================

Make the navigation work properly on:

- Desktop
- Tablet
- Mobile/PWA

On mobile, Favorites should be easily accessible without making the navigation crowded.

==================================================
9. PERFORMANCE
==================================================

Do not make a database request every time the sidebar renders.

Use the simplest appropriate existing storage approach.

If favorites are stored server-side, load them efficiently and cache where appropriate.

Do not create unnecessary API calls.

==================================================
10. FINAL GOAL
==================================================

The owner should be able to open TableFlow and immediately see the features they use every day.

The experience should feel like:

OPEN TABLEFLOW
→ See Favorites
→ Click POS / Inventory / Reports
→ Work immediately

Keep it simple, fast and professional.

First inspect the current sidebar/navigation and existing architecture.

Then implement only what is missing.

Do not duplicate routes, permissions or feature systems.

Run existing tests and add tests for Favorites, Recent, permissions and responsive behavior.