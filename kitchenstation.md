Implement a complete “Kitchen Stations / Kitchen Sections” system for the existing restaurant POS and KDS.

IMPORTANT:
This must be fully integrated with the existing order, menu, branch, table, QR ordering, cashier, waiter, and kitchen workflows.

Do not create a separate kitchen system.

This kitchen workflow is INTERNAL ONLY. Customers must never see:
- Kitchen stations
- Kitchen staff
- Internal preparation statuses
- Internal routing
- Kitchen acceptance workflow

The customer ordering flow must remain the same as the existing system.

==================================================
1. KITCHEN STATIONS
==================================================

Create a Kitchen Stations management feature.

The Shop Owner/Admin must be able to create, edit, activate, deactivate, and remove kitchen stations.

Examples:

- Rice & Curry Station
- Burger & Bun Station
- Pizza Station
- Drinks & Beverages Station
- Kottu Station
- Grill / BBQ Station
- Desserts Station
- Bakery Station

The owner can create any custom station based on the restaurant's needs.

For example:

Restaurant A:
- Rice
- Burgers
- Drinks

Restaurant B:
- Indian Kitchen
- Tandoori
- Juice Bar
- Desserts

Do not hardcode kitchen station names.

Each kitchen station should have:

- Station Name
- Optional Description
- Branch
- Active / Inactive Status
- Assigned Staff
- Display Order / Priority
- Optional Printer Assignment if the system supports kitchen printing

==================================================
2. BRANCH ISOLATION
==================================================

Kitchen stations must be branch-specific.

Example:

Main Branch:
- Rice Station
- Burger Station
- Drinks Station

Kandy Branch:
- Pizza Station
- Drinks Station

Each branch can have completely different kitchen stations.

Orders from one branch must NEVER appear in another branch's kitchen station.

Example:

An order from Kandy Branch:
- Must use only Kandy Branch stations.
- Must never appear in Main Branch kitchen screens.

Enforce branch isolation in:
- Database
- Backend/API
- Permissions
- Real-time events
- Kitchen display queries

Do not rely only on frontend filtering.

==================================================
3. MENU ITEM TO KITCHEN STATION MAPPING
==================================================

When creating or editing a menu item, add a required or configurable field:

“KITCHEN STATION”

The owner/admin must assign the menu item to the station responsible for preparing it.

Example:

Fried Rice
→ Rice & Curry Station

Chicken Burger
→ Burger & Bun Station

Pizza
→ Pizza Station

Mango Juice
→ Drinks Station

Chocolate Cake
→ Desserts Station

The available stations must only be from the correct branch.

If menus are shared across branches, the kitchen station mapping must support branch-specific assignments where necessary.

Example:

Pizza at Main Branch
→ Pizza Station

Pizza at Kandy Branch
→ Main Kitchen

Do not automatically assume the same station exists in every branch.

==================================================
4. ORDER FLOW
==================================================

Customer ordering flow remains unchanged:

Customer QR / Cashier / Waiter
→ Creates Order
→ Order Confirmed
→ Order Sent to Kitchen

Example order:

Table 05

- 1 Pizza
- 1 Fried Rice
- 1 Mango Juice

Initially, this should be handled as ONE CUSTOMER ORDER.

The order must have one main Order ID.

Example:

Order #1025

The customer, cashier, and waiter should continue to see the order as one order.

After the order is accepted by the kitchen workflow, the system must automatically split the INTERNAL preparation tasks according to the assigned kitchen stations.

Example:

Order #1025

Pizza
→ Pizza Station

Fried Rice
→ Rice Station

Mango Juice
→ Drinks Station

IMPORTANT:

This is an internal kitchen routing process.

The customer must still see only their normal order flow.

==================================================
5. KITCHEN ACCEPTANCE FLOW
==================================================

When a new order is sent to the kitchen:

NEW ORDER
→ Appears in the central kitchen incoming queue / kitchen acceptance screen.

The designated Kitchen Supervisor or authorized kitchen staff can:

- View the complete order
- Accept the order
- Reject the order only if the existing system supports rejection
- See special instructions
- See table/order source
- See order time

Example:

Order #1025

Table: 05

1 Pizza
1 Fried Rice
1 Mango Juice

Status:
WAITING FOR KITCHEN ACCEPTANCE

After the authorized kitchen person clicks ACCEPT:

The system automatically creates internal kitchen tasks and routes each item to the correct station.

==================================================
6. INTERNAL AUTO-ROUTING AFTER ACCEPTANCE
==================================================

After accepting Order #1025:

Pizza Station receives:

Order #1025
Table 05

1 Pizza

Rice Station receives:

Order #1025
Table 05

1 Fried Rice

Drinks Station receives:

Order #1025
Table 05

1 Mango Juice

Each station must only see the items assigned to that station.

Example:

Pizza Station staff must NOT see:
- Fried Rice preparation details
- Mango Juice preparation details

They may only see minimal order context if needed, such as:
- Order number
- Table number
- Order time
- Customer notes relevant to the order

Do not expose unrelated items to a station.

==================================================
7. KITCHEN STATION WORKFLOW
==================================================

Each station should have its own KDS screen.

Recommended statuses:

QUEUED
→ Item has been routed to the station.

PREPARING
→ Station staff started preparing the item.

READY
→ Item preparation is complete.

SERVED
→ Item was delivered to the customer.

CANCELLED
→ Item was cancelled.

The station staff should normally control:

QUEUED
→ PREPARING
→ READY

The waiter/service staff should normally control:

READY
→ SERVED

This creates proper separation of responsibility.

Kitchen staff must not accidentally mark food as SERVED unless the owner has specifically granted that permission.

==================================================
8. MASTER ORDER STATUS
==================================================

The main customer order must remain ONE order.

Do not create multiple customer orders.

Internally, the order can have multiple station tasks.

Example:

Order #1025

Pizza:
PREPARING

Fried Rice:
READY

Mango Juice:
SERVED

The main order should automatically calculate its overall status from item statuses.

Example:

If any item is PREPARING:
Overall Order = IN PROGRESS

If all non-cancelled items are READY:
Overall Order = READY

If some items are SERVED and others are still pending:
Overall Order = PARTIALLY SERVED

If all non-cancelled items are SERVED:
Overall Order = COMPLETED / SERVED

Cancelled items must be excluded from completion calculations.

==================================================
9. MULTIPLE ITEMS FOR THE SAME STATION
==================================================

If multiple items belong to the same kitchen station, group them under the same station task while keeping individual item status.

Example:

Order #1025:

Pizza Station:
- 1 Chicken Pizza
- 1 Cheese Pizza

Rice Station:
- 1 Fried Rice

Drinks Station:
- 2 Mango Juice
- 1 Coke

The station can see all its assigned items from that order together.

However, individual item quantities and statuses must remain trackable.

==================================================
10. ADDITIONAL ITEMS AFTER INITIAL ORDER
==================================================

If a customer adds more items later:

Example:

Original order:

1 Pizza
1 Mango Juice

Later adds:

1 Fried Rice

Do NOT resend or reset already accepted/preparing items.

Create a new internal kitchen task only for the newly added item.

Example:

Pizza:
Already PREPARING
→ Do not change.

Mango Juice:
Already READY
→ Do not change.

New Fried Rice:
Route to Rice Station as a new task.

The kitchen should clearly identify new additions.

Example:

NEW ADDITION
Order #1025
Table 05
1 Fried Rice

==================================================
11. STATION STAFF AND PERMISSIONS
==================================================

The Shop Owner/Admin must be able to assign staff to each kitchen station.

Example:

Rice Station:
- Chef A
- Chef B

Drinks Station:
- Staff C

Pizza Station:
- Chef D

Kitchen staff must only see:

- Their assigned branch
- Their assigned kitchen station(s)
- Orders/items routed to those station(s)

They must not see:
- Other branch kitchen orders
- Other stations unless permission is given
- Financial reports
- Cash drawer information
- Sensitive admin data

Support one staff member being assigned to multiple stations if authorized.

==================================================
12. KITCHEN DASHBOARD
==================================================

Create a professional internal Kitchen Dashboard.

For a station user, show only the relevant station.

Recommended columns:

NEW / QUEUED
PREPARING
READY

Each item/task card should show:

- Order number
- Table number or order source
- Time since received
- Item name
- Quantity
- Modifiers/options
- Special instructions
- Priority
- Status

Example:

ORDER #1025
TABLE 05
Received: 12 minutes ago

1 × Chicken Pizza
Extra Cheese
No Onion

[START PREPARING]

After starting:

[MARK READY]

Do not show unnecessary customer financial information on the kitchen screen.

==================================================
13. KITCHEN SUPERVISOR VIEW
==================================================

If the restaurant has a Kitchen Supervisor role, create a broader kitchen overview.

The Kitchen Supervisor can see:

- Incoming orders waiting for acceptance
- All kitchen stations for their branch
- Orders currently preparing
- Delayed items
- Ready items
- Station workload
- Items waiting too long

The Supervisor must not see another branch unless explicitly authorized.

==================================================
14. DELAY AND PRIORITY LOGIC
==================================================

Track timing separately for each station task.

Store timestamps such as:

- Order confirmed
- Sent to kitchen
- Accepted
- Routed to station
- Preparation started
- Ready
- Served

Calculate:

Kitchen Waiting Time:
Preparation Started - Routed/Received Time

Preparation Duration:
Ready Time - Preparation Start Time

Ready Waiting Time:
Served Time - Ready Time

This allows the system to identify whether a delay is caused by:

- Kitchen acceptance delay
- Station workload delay
- Preparation delay
- Food waiting to be served

Add configurable alerts for:

- Item waiting too long in QUEUED
- Item preparing too long
- Item READY but not served
- Station with too many pending items

==================================================
15. ORDER PRIORITY
==================================================

Default kitchen priority should be based on:

1. Order waiting time
2. Delay threshold
3. Existing restaurant priority rules

The oldest waiting items should generally receive higher priority.

However, allow authorized users to manually mark an order as:

NORMAL
HIGH PRIORITY
URGENT

Manual priority changes must be logged with:

- Who changed it
- Previous priority
- New priority
- Time
- Optional reason

==================================================
16. MENU ITEM WITHOUT A KITCHEN STATION
==================================================

Prevent orders from being accepted if an item requires kitchen preparation but has no valid station mapping.

Provide clear handling.

Example:

“Chicken Burger is not assigned to a Kitchen Station for this branch.”

The owner/admin must fix the menu mapping.

Do not silently send the item to the wrong station.

For non-kitchen items, support an explicit option such as:

NO KITCHEN REQUIRED

Examples:
- Bottled Water
- Packaged Snacks

These items should not enter the kitchen routing workflow.

They should follow the appropriate existing cashier/service flow.

==================================================
17. INACTIVE OR UNAVAILABLE STATION
==================================================

If a menu item is mapped to an inactive or unavailable station:

Do not automatically route the item to another random station.

Show a controlled error/exception to authorized staff.

Optionally allow an authorized supervisor to manually reassign the item to another compatible station.

Every manual reassignment must be logged.

==================================================
18. MANUAL ROUTING OVERRIDE
==================================================

Normally, routing must be automatic.

However, authorized Kitchen Supervisor/Admin users may manually move a pending item to another station when needed.

Example:

Pizza Station is unavailable.

1 Pizza
→ Manually reassigned to Main Kitchen.

The system must record:

- Original station
- New station
- Who reassigned it
- Date/time
- Reason

Kitchen staff without permission cannot reassign items.

==================================================
19. CANCELLATION LOGIC
==================================================

If an item is cancelled:

Before preparation:
- Cancel the station task/item.
- Remove it from active preparation.

During preparation:
- Require authorized cancellation according to existing business rules.

After READY:
- Require authorized action.

After SERVED:
- Follow the existing order correction/void process.

Cancelled items must:

- Stop active kitchen timers
- Be excluded from food progress calculations
- Be excluded from completed quantity calculations
- Not incorrectly trigger delayed alerts

Do not silently delete kitchen history.

==================================================
20. INTEGRATION WITH WAITER
==================================================

When a kitchen station marks an item READY:

The relevant waiter/service workflow must receive the update.

Example:

Table 05:

Pizza → PREPARING
Fried Rice → READY
Mango Juice → READY

Waiter sees:

TABLE 05
2 ITEMS READY TO SERVE

The waiter can mark the correct items as SERVED.

The kitchen station does not need to see unrelated waiter functions.

==================================================
21. INTEGRATION WITH LIVE TABLE DASHBOARD
==================================================

The existing Live Table & Customer Dashboard must automatically use the station/item statuses.

For each table, correctly calculate:

- Ordered quantity
- Queued quantity
- Preparing quantity
- Ready quantity
- Served quantity

Example:

Table 05:

Ordered: 5
Queued: 1
Preparing: 2
Ready: 1
Served: 1

Do not calculate progress from the number of kitchen tickets.

Calculate it from actual item quantities.

The dashboard must update in real time when any kitchen station changes an item status.

==================================================
22. REAL-TIME FLOW
==================================================

The complete internal flow should be:

CUSTOMER / WAITER / CASHIER
        ↓
CREATE ORDER
        ↓
CONFIRM ORDER
        ↓
SEND TO CENTRAL KITCHEN INCOMING QUEUE
        ↓
KITCHEN SUPERVISOR / AUTHORIZED STAFF ACCEPTS
        ↓
SYSTEM AUTOMATICALLY ANALYZES EACH ITEM
        ↓
ITEMS ARE ROUTED TO THE CORRECT KITCHEN STATION
        ↓
RICE STATION
BURGER STATION
PIZZA STATION
DRINKS STATION
DESSERT STATION
        ↓
EACH STATION UPDATES ITS OWN ITEM STATUS
        ↓
READY ITEMS NOTIFY THE RELEVANT WAITER/SERVICE TEAM
        ↓
WAITER MARKS ITEMS AS SERVED
        ↓
MAIN ORDER STATUS UPDATES AUTOMATICALLY
        ↓
LIVE TABLE DASHBOARD UPDATES
        ↓
CUSTOMER ORDER FLOW REMAINS SIMPLE AND UNCHANGED

==================================================
23. CUSTOMER VISIBILITY
==================================================

The customer must continue to see the existing normal order flow only.

Do NOT show the customer:

- Kitchen station names
- Which chef is preparing food
- Internal acceptance status
- Internal routing details
- Staff assignments
- Kitchen delays caused by a specific station

The customer-facing status should remain simple, for example:

Order Confirmed
Preparing
Ready / On the Way
Served

Map internal statuses to customer-visible statuses where appropriate.

Example:

Internal:
Queued at Rice Station
Preparing at Pizza Station
Ready at Drinks Station

Customer:
Preparing

==================================================
24. REPORTING AND HISTORY
==================================================

Store historical kitchen data for reporting.

Support reports such as:

- Orders handled by each kitchen station
- Average preparation time by station
- Average preparation time by menu item
- Delayed items by station
- Number of orders completed by station
- Peak workload times
- Ready-to-served waiting time
- Kitchen acceptance time

All reports must respect:
- Branch isolation
- Date range
- User permissions

==================================================
25. DATA MODEL AND INTEGRITY
==================================================

Use a proper relational structure.

Recommended logic:

Branch
→ Kitchen Stations

Menu Item
→ Kitchen Station Assignment

Order
→ Order Items

Order Item
→ Internal Kitchen Task / Station Assignment

Kitchen Task
→ Status History
→ Assigned Station
→ Timing Data

Keep the main customer order intact.

Do not duplicate the order for each kitchen station.

Do not create multiple customer-facing order numbers.

Internal kitchen tasks may reference the same main order.

==================================================
26. REQUIRED TESTING
==================================================

Test all of the following:

1. Owner can create a custom kitchen station.
2. Owner can edit a station.
3. Owner can deactivate a station.
4. Owner can remove a station when allowed.
5. Menu items can be assigned to a station.
6. Different branches can have different stations.
7. Branch A orders never appear in Branch B.
8. One order can contain items for multiple stations.
9. The complete order appears in the central acceptance queue.
10. After acceptance, items automatically route to correct stations.
11. Pizza appears only at Pizza Station.
12. Fried Rice appears only at Rice Station.
13. Mango Juice appears only at Drinks Station.
14. Customer still sees one normal order.
15. Kitchen staff cannot see unrelated stations without permission.
16. Kitchen staff cannot see another branch.
17. Multiple items for the same station are grouped correctly.
18. Individual item quantities remain accurate.
19. Partial preparation works.
20. Partial serving works.
21. Additional items route without resetting existing items.
22. Ready items notify the correct waiter/service flow.
23. Served status updates the main order.
24. Cancelled items are handled correctly.
25. Delayed items trigger alerts.
26. Station timers are calculated correctly.
27. Kitchen acceptance time is tracked.
28. Manual reassignment is permission-controlled and logged.
29. Orders without valid station mapping are handled safely.
30. Non-kitchen items do not enter kitchen routing.
31. Inactive stations do not silently receive orders.
32. Live Table Dashboard updates correctly.
33. All real-time events remain branch-isolated.
34. Existing customer ordering, QR, waiter, cashier, kitchen, and branch logic is not broken.

==================================================
FINAL EXPECTED RESULT
==================================================

Create a professional multi-station kitchen management system where the Shop Owner can create any kitchen sections required by the restaurant.

Example:

Pizza + Fried Rice + Mango Juice

The customer places ONE order.

Internally:

ONE ORDER
        ↓
KITCHEN ACCEPTANCE
        ↓
AUTO-ROUTE BY MENU ITEM
        ↓
Pizza → Pizza Station
Fried Rice → Rice Station
Mango Juice → Drinks Station
        ↓
Each station prepares only its assigned items
        ↓
Items become READY
        ↓
Waiter receives ready notification
        ↓
Waiter marks items SERVED
        ↓
The main order and live table dashboard update automatically.

The entire station routing and preparation workflow must remain INTERNAL.

Customers should experience the same simple ordering process as before.

The final implementation must be:
- Branch-isolated
- Permission-controlled
- Real-time
- Configurable by the Shop Owner
- Accurate at item and quantity level
- Fully integrated with the existing POS
- Safe for additional orders and cancellations
- Connected to waiter/service flow
- Connected to the Live Table Dashboard
- Based on real database records, not static frontend data