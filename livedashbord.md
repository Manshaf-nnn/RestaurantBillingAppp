Implement a new professional real-time “Table & Customer Live Dashboard” in the existing restaurant POS.

IMPORTANT:
First inspect the existing application structure, database schema, order flow, table system, branch logic, QR ordering flow, kitchen/KOT workflow, customer records, role permissions, and existing UI components.

Reuse the existing architecture and real data wherever possible.

Do not create fake/demo data.
Do not create a separate disconnected system.
Do not duplicate existing order, customer, or table logic.

This dashboard must use real saved data and update automatically as orders, tables, kitchen statuses, customers, and payments change.

==================================================
UI AND DESIGN REQUIREMENT
==================================================

The UI must match the existing POS system exactly.

Use the existing:
- Theme
- Colors
- Sidebar
- Header
- Cards
- Buttons
- Typography
- Icons
- Spacing
- Border radius
- Status styles
- Responsive design patterns

Do NOT copy the branding, restaurant name, logo, or exact visual identity from any sample/reference.

The sample is only a functional and layout reference.

The final dashboard must feel like a natural, native part of the existing POS system.

==================================================
1. DASHBOARD PURPOSE
==================================================

Create a real-time management control dashboard that allows an authorized manager or owner to understand the restaurant's current situation within 5–10 seconds.

The dashboard should combine:

- Live table monitoring
- Waiting-time monitoring
- Food progress
- Kitchen preparation status
- Customer information
- Customer visit history
- Returning customer recognition
- Long-time return customer recognition
- Delayed table detection
- Service alerts
- Needs Attention alerts

This is NOT just a visual report.

It is a live operational management screen.

==================================================
2. BRANCH-AWARE ACCESS AND ISOLATION
==================================================

This dashboard must strictly follow the existing branch isolation logic.

Every record must belong to the correct branch.

Branch data includes:
- Tables
- QR codes
- Orders
- KOTs
- Kitchen items
- Cashier activity
- Customers' current visits
- Dashboard KPIs
- Alerts

For a Branch Manager:

- Automatically load only the manager's assigned branch.
- Do not show a branch selector unless permission allows it.
- The manager must never access another branch through UI, URL manipulation, API requests, or real-time events.

For Owner/Admin:

- Show a branch selector.
- The Owner/Admin can select a branch and see that branch's live dashboard.
- Each selected branch must show only its own records.
- Optionally support an “All Branches” view only if explicitly authorized.

Branch isolation must be enforced in:
- Database queries
- Backend services
- API authorization
- Real-time subscriptions/events

Do NOT rely only on frontend filtering.

==================================================
3. TOP LIVE SUMMARY
==================================================

At the top, display live KPI cards for the selected branch.

Include:

1. Tables Occupied
Number of currently active/occupied tables.

2. Waiting Tables
Number of active tables with pending or unserved food.

3. Delayed Tables
Number of active tables exceeding the configured delay threshold.

4. Food Ordered
Total active ordered item quantity.

5. Preparing
Total item quantity currently in preparation.

6. Ready
Show this if the existing kitchen workflow supports a Ready status.

7. Served
Total served item quantity.

8. Overall Food Served Percentage

Calculation:

Total Served Quantity
÷
Total Active Ordered Quantity Excluding Cancelled Quantity
× 100

Example:

Ordered = 64
Served = 43

43 ÷ 64 × 100 = 67%

Cancelled items must be excluded from the denominator.

Also show:
- Current date
- Current time
- LIVE status indicator

The dashboard must update automatically without requiring a manual refresh.

==================================================
4. WAITING TIME PRIORITY
==================================================

Create a prominent “Waiting Time Priority” section.

Automatically sort active waiting tables from longest waiting time to shortest.

For each table show:

- Priority number
- Table number/name
- Waiting duration
- Ordered quantity
- Preparing quantity
- Ready quantity if applicable
- Served quantity
- Food progress percentage
- Current status

Example:

Priority 1
Table 08
Waiting: 32 minutes
Served: 2/5
Preparing: 3
Progress: 40%
Status: Delayed

The priority list must automatically reorder as time and order statuses change.

Empty tables must never appear in this list.

==================================================
5. WAITING TIME LOGIC
==================================================

Waiting time and kitchen preparation time must be separate.

WAITING TIME:

For dine-in/table orders:

Start the waiting timer only when:
- The order is confirmed, AND
- The order/KOT is successfully sent to the kitchen.

Do NOT start the waiting timer when:
- The customer scans the QR code
- The customer opens the menu
- Items are added to the cart but not confirmed

The waiting timer continues while the table has active pending items.

When all non-cancelled items are served, the active waiting timer stops.

If new items are added later, the system must handle the new items correctly without incorrectly resetting the history.

Prefer tracking both:
- Overall table service duration
- Item/order-level waiting duration

This allows the dashboard to identify new items added to an existing table separately.

KITCHEN PREPARATION TIME:

Preparation time begins separately when an item/order enters the actual kitchen workflow according to the existing system.

Track the relevant timestamps, such as:
- KOT sent
- Accepted
- Preparation started
- Ready
- Served

This must allow the system to distinguish between:

- Delay before kitchen starts work
- Long kitchen preparation
- Food ready but waiting to be served
- General table/service delay

Do not use one timer for everything.

==================================================
6. WAITING TIME STATUS RULES
==================================================

Use automatic status levels.

Default values:

0–10 minutes:
NORMAL

11–15 minutes:
WATCH

16–20 minutes:
ATTENTION

21–30 minutes:
DELAYED

30+ minutes:
CRITICAL / MANAGER ATTENTION

These values must be configurable.

Owner/Admin must be able to set the thresholds in Settings.

Validate that thresholds are logically increasing.

Example:

Normal: 10
Watch: 15
Attention: 20
Delayed: 30

Use the existing system's design and status styles.

==================================================
7. LIVE TABLE VIEW
==================================================

Create a central live table view showing table cards.

Each active table card should show:

- Table number/name
- Current waiting time
- Guest count if available
- Customer recognition badge
- Ordered quantity
- Preparing quantity
- Ready quantity if applicable
- Served quantity
- Food served percentage
- Progress bar
- Current status

Example:

TABLE 08
Waiting: 32 min

Ordered: 5
Preparing: 3
Served: 2

40% Served

Customer:
FIRST VISIT

Another example:

TABLE 12
Waiting: 8 min

Ordered: 5
Preparing: 1
Served: 4

80% Served

Customer:
REGULAR
14 Visits

TABLE CARDS MUST REMAIN SIMPLE.

The manager should understand the situation immediately.

==================================================
8. CUSTOMER RECOGNITION AND RETURN STATUS
==================================================

Add an automatic customer recognition system.

The system must calculate the customer's current visit status using real completed visit/order history.

Show one primary customer type:

⭐ FIRST VISIT
For a new customer with no previous completed visits.

🔁 RETURNING
For a customer who has returned but has not reached Regular or VIP status.

💚 REGULAR
For a frequent customer who meets the configured Regular threshold.

💎 VIP
For a customer who meets the configured VIP threshold based on configured visit count and/or customer value.

Additionally, calculate how long it has been since the customer's previous completed visit.

Add these special return indicators:

👋 WELCOME BACK
For a customer returning after a medium/long gap.

Default:
30–89 days since the previous completed visit.

🌟 LONG-TIME RETURN
For a customer returning after a very long gap.

Default:
90+ days since the previous completed visit.

IMPORTANT:
WELCOME BACK and LONG-TIME RETURN are return-gap indicators.

They can be shown together with the customer's primary status.

Example:

💚 REGULAR
🌟 LONG-TIME RETURN

or:

🔁 RETURNING
👋 WELCOME BACK

Do not make these statuses conflict.

The hierarchy should be:

Primary Customer Status:
FIRST VISIT / RETURNING / REGULAR / VIP

Secondary Return Indicator:
None / WELCOME BACK / LONG-TIME RETURN

Example table card:

TABLE 03 — 27 MIN

Ordered: 4
Preparing: 3
Served: 1

25% SERVED

🔁 RETURNING
🌟 LONG-TIME RETURN

Last Visit: 14 Mar 2026
Returned After: 165 Days
Total Visits: 6

The LONG-TIME RETURN badge should be visually noticeable using a special style that fits the existing system design.

Do not copy any external brand colors.

==================================================
9. RETURN GAP CALCULATION
==================================================

Calculate the return gap accurately.

When a known customer starts a new visit:

1. Identify the current customer.
2. Find the customer's most recent previous completed visit/order.
3. Do not include the current active visit.
4. Calculate:

Current Visit Start Date
-
Previous Completed Visit Date
=
Returned After X Days

Example:

Previous completed visit:
14 Mar 2026

Current visit:
26 Aug 2026

Returned after:
165 days

The system must not count cancelled orders or incomplete abandoned orders as valid customer visits.

Use the restaurant's configured timezone for the calculation.

Do not rely only on browser local time.

==================================================
10. CUSTOMER RETURN SETTINGS
==================================================

Add configurable customer recognition settings.

Owner/Admin can configure:

Customer Status Thresholds:
- Regular after X visits
- VIP after X visits
- Optional VIP minimum lifetime spend/value

Return Gap Thresholds:
- WELCOME BACK after X days
- LONG-TIME RETURN after Y days

Default:

WELCOME BACK:
30 days

LONG-TIME RETURN:
90 days

Example:

The Owner may change:
- Welcome Back = 60 days
- Long-Time Return = 180 days

Validation:

Long-Time Return threshold must be greater than Welcome Back threshold.

Example logic:

0–29 days:
Normal return, no special return-gap badge

30–89 days:
WELCOME BACK

90+ days:
LONG-TIME RETURN

All values must be configurable.

==================================================
11. CUSTOMER DETAILS PANEL
==================================================

When the manager clicks a table card, open/update the Customer Details panel.

Show:

CUSTOMER PROFILE:
- Customer name
- Mobile number only if permitted
- Current table
- Guest count
- Primary customer status
- Return-gap indicator
- Current visit duration

VISIT HISTORY:
- First Visit / Returning / Regular / VIP
- Total completed visits
- Previous visit date
- Returned After X days
- Current visit duration

Optional future-ready fields:
- Lifetime completed orders
- Lifetime spend
- Favourite items
- Most frequently ordered items
- Customer notes

If no customer identity is available:

Show:
Guest / Unidentified Customer

Do not create a fake customer profile.

==================================================
12. FOOD PROGRESS CALCULATION
==================================================

Calculate food progress using actual item quantities.

Do NOT calculate progress using only:
- Number of orders
- Number of KOTs

Formula:

Served Quantity
÷
Total Active Ordered Quantity Excluding Cancelled Quantity
× 100

Example:

2 Chicken Rice
2 Drinks
1 Dessert

Total = 5

Served = 3

Progress:

3 ÷ 5 × 100 = 60%

Partial serving must work correctly.

Example:

Ordered:
5 × Chicken Rice

Served:
2 × Chicken Rice

Remaining:
3

Cancelled quantities must be excluded.

==================================================
13. NEEDS ATTENTION
==================================================

Create a prominent “Needs Attention” section.

Automatically detect operational problems.

CRITICAL:
- Table waiting beyond critical threshold
- No food served after a configured long time
- Order/item stuck in preparation too long

DELAYED:
- Table exceeds delayed threshold
- Very low progress after a long wait

ATTENTION:
- Some food served while remaining items are preparing for too long
- Food is Ready but not marked Served for too long
- First-time customer waiting too long
- VIP customer waiting too long
- LONG-TIME RETURN customer waiting too long
- Unusually long table service duration

PAYMENT ATTENTION:
- All food served but payment remains pending beyond a configured time

Example:

TABLE 08
CRITICAL
Waiting: 32 minutes
Only 40% served
3 items still preparing

TABLE 03
DELAYED
Waiting: 27 minutes
Only 25% served

TABLE 15
ATTENTION
Waiting: 19 minutes
2 items still preparing

For customer-sensitive alerts:

Example:

TABLE 05
ATTENTION
🌟 LONG-TIME RETURN CUSTOMER
Waiting: 22 minutes
No food served yet

This helps the manager or waiter personally welcome and prioritize valuable returning customers.

Do not create duplicate alerts.

When the underlying issue is resolved:
- Mark the alert resolved automatically, OR
- Remove it from active alerts according to the existing alert design.

==================================================
14. ORDER AND TABLE DRILL-DOWN
==================================================

When a user clicks a table:

Table Card
→ Select Table
→ Update Customer Details
→ Update Current Order Summary
→ Show relevant alerts

Show Current Order Summary:

- Total ordered quantity
- Preparing quantity
- Ready quantity
- Served quantity
- Cancelled quantity
- Remaining quantity
- Food progress percentage

Add:

View Order Details

This must open the existing order details page/modal using the correct real order.

Do not create duplicate order records.

==================================================
15. LIVE UPDATE FLOW
==================================================

The dashboard must automatically update when:

- A table becomes occupied
- A table becomes available
- A new order is confirmed
- Additional items are added
- KOT is sent
- Kitchen accepts an order/item
- Preparation starts
- Item becomes Ready
- Item is Served
- Item is Cancelled
- Customer is assigned
- Payment is completed
- Table/order is closed

The dashboard must also update customer recognition when:
- A known customer starts a new visit
- Their previous visit is identified
- Visit count changes after completion

Waiting timers should update continuously without reloading the entire page.

Use the existing application's real-time architecture if available.

If the system already uses:
- WebSockets
- Socket.IO
- Server-Sent Events
- Database real-time subscriptions

Reuse it.

Do not reload the full dashboard every second.

Recommended approach:

- Server/database sends actual state changes.
- Frontend efficiently updates live timers locally.
- Periodically resynchronize if required.

==================================================
16. QR ORDER FLOW AND BRANCH ISOLATION
==================================================

This must work correctly with the existing branch-specific QR and table system.

Correct flow:

Branch QR
→ Identify Correct Branch
→ Show Only That Branch's Tables
→ Customer Selects Valid Table
→ Create Order with Correct Branch ID
→ Send KOT to Correct Branch Kitchen
→ Update Correct Branch Dashboard

Example:

If the customer accesses Branch B QR:

The customer must never see:
- Branch A tables
- Branch A menu context if menus are branch-specific
- Branch A kitchen
- Branch A order records

If Branch B only has Table 3:

The customer must not be able to select or submit an order for Table 2 from Branch A.

Enforce this in the backend.

==================================================
17. ROLE PERMISSIONS
==================================================

Integrate this feature with the existing custom role and feature-permission system.

Add permissions such as:

- View Live Dashboard
- View Customer Information
- View Customer History
- View Customer Return Indicators
- View Needs Attention
- View Order Details
- View All Branch Dashboards
- Configure Dashboard Settings

Owner/Admin:
Access according to assigned permissions.

Branch Manager:
Only assigned branch unless explicitly authorized otherwise.

Cashier:
Optional limited access if enabled.

Kitchen:
Optional kitchen-focused access if enabled.

Do not expose customer history or sensitive details to unauthorized roles.

==================================================
18. SETTINGS
==================================================

Add an authorized Settings area for this dashboard.

Allow configuration of:

WAITING TIME:
- Normal threshold
- Watch threshold
- Attention threshold
- Delayed threshold
- Critical threshold

CUSTOMER STATUS:
- Regular after X visits
- VIP after X visits
- Optional VIP minimum lifetime spend

RETURN GAP:
- Welcome Back after X days
- Long-Time Return after Y days

ALERTS:
- No food served after X minutes
- Item stuck preparing after X minutes
- Ready but not served after X minutes
- Payment pending after X minutes

Support:
- Restaurant/company-level defaults
- Optional branch-level overrides if required

If branch overrides exist:

Branch setting
→ Overrides company default

If no branch setting exists:

Use company default.

==================================================
19. DATE AND TIME
==================================================

Use the correct restaurant/branch timezone.

All timestamps must be handled consistently.

Use accurate timestamps for:
- Order confirmation
- KOT sent
- Preparation start
- Ready
- Served
- Previous completed visit
- Current visit start
- Payment completion
- Table close

Return-gap calculations and waiting calculations must use the configured timezone.

==================================================
20. RESPONSIVE LAYOUT
==================================================

Desktop/Large Screen:

TOP:
Live KPI summary

LEFT:
Waiting Time Priority

CENTER:
Live Table View

RIGHT:
Customer Details + Current Order Summary

BOTTOM:
Needs Attention

The layout should show as much important information as possible without requiring unnecessary page navigation.

For smaller screens:
- Stack panels intelligently
- Preserve priority information
- Avoid overcrowding
- Keep the dashboard usable

==================================================
21. DATA INTEGRITY
==================================================

Use real saved data.

Never:

- Create fake customer visits
- Double-count item quantities
- Double-count served quantities
- Count cancelled quantities as active
- Mix data between branches
- Reset customer history when orders are edited
- Count the current active visit as a previous visit
- Count abandoned or cancelled orders as completed visits
- Create duplicate alerts

Completed historical orders must not be treated as active waiting orders.

==================================================
22. PERFORMANCE
==================================================

Optimize for many tables and branches.

For the live dashboard:

Load only:
- Active tables
- Active orders
- Relevant KOT/item statuses
- Required customer information
- Active alerts

Do not repeatedly load the entire historical order database.

Load deeper customer history only when needed.

Ensure appropriate indexes for fields such as:

- branch_id
- table_id
- order_id
- customer_id
- order status
- item status
- created_at
- completed_at

==================================================
23. REQUIRED TESTING
==================================================

Before considering this feature complete, test all of the following:

1. Occupied table count is correct.
2. Waiting table count is correct.
3. Delayed table count follows settings.
4. Ordered quantities are correct.
5. Preparing quantities are correct.
6. Ready quantities are correct.
7. Served quantities are correct.
8. Overall served percentage is correct.
9. Cancelled quantities are excluded.
10. Partial serving works.
11. Priority list sorts longest waiting first.
12. Waiting time starts only after confirmed order/KOT submission.
13. Kitchen preparation time is separate.
14. Empty tables do not appear as waiting.
15. Clicking a table loads correct customer details.
16. First-time customers are correctly identified.
17. Returning customers use actual completed visit history.
18. Regular customers follow configured thresholds.
19. VIP customers follow configured thresholds.
20. Welcome Back calculation is correct.
21. Long-Time Return calculation is correct.
22. Current active visit is not counted as the previous visit.
23. Previous cancelled/abandoned orders are not counted as valid visits.
24. Return-gap thresholds can be changed.
25. Welcome Back and Long-Time Return badges appear correctly.
26. Primary customer status and return-gap indicator can coexist correctly.
27. Long-Time Return customers can trigger relevant attention alerts.
28. Needs Attention alerts are created correctly.
29. Duplicate alerts are prevented.
30. Alerts resolve when the issue is resolved.
31. Dashboard updates when kitchen status changes.
32. Dashboard updates when food is served.
33. Dashboard updates when items are cancelled.
34. Branch A never displays Branch B data.
35. Branch-specific QR orders go only to the correct branch.
36. Orders go only to the correct branch kitchen.
37. Branch Managers cannot access other branches.
38. Owner/Admin branch selector works correctly.
39. Unauthorized users cannot bypass permissions through URLs or APIs.
40. Existing order, table, kitchen, customer, branch, QR, and payment functionality is not broken.
41. The dashboard works with multiple simultaneous active tables.
42. The dashboard performs efficiently.
43. The final UI fully matches the existing POS design.

==================================================
FINAL EXPECTED RESULT
==================================================

Build a real-time restaurant management control dashboard where an authorized manager or owner can immediately understand:

- Which tables are occupied
- Which tables have waited the longest
- Which tables are delayed or critical
- How much food has been ordered, preparing, ready, and served
- Which tables need immediate attention
- Whether delays are caused by kitchen preparation or service
- Whether a customer is new, returning, regular, or VIP
- Whether a customer has returned after a long gap
- The customer's last visit date
- How many days it took for the customer to return
- Total completed visits
- Current order progress
- Current service duration

The special return logic must clearly identify valuable customers such as:

🌟 LONG-TIME RETURN
A customer returning after the configured long gap, for example 90+ days.

This is an opportunity for the manager or waiter to personally recognize and welcome the customer.

The system must be:

- Real-time
- Based on actual POS data
- Branch-isolated
- Permission-controlled
- Configurable
- Historically accurate
- Efficient
- Responsive
- Fully integrated with existing orders, tables, kitchen, QR, customer, and branch logic

Do not implement this as static frontend cards only.

Implement the actual database logic, backend validation, calculations, customer visit logic, return-gap calculations, permissions, branch isolation, real-time updates, alerts, settings, and responsive UI.