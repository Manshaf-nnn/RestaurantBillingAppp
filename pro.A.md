TABLEFLOW — CUSTOMER CRM + POS + LOYALTY + REALTIME + BUG FIX MASTER IMPLEMENTATION PROMPT

IMPORTANT:
Before changing any code, inspect the ENTIRE existing project architecture and current implementations related to:

- Customers / CRM
- Customer insights
- POS
- Orders
- Dine-in / Counter / Takeaway / Delivery
- Invoices / Billing
- Payments / Split payments
- Loyalty
- Discounts
- Inventory / Stock items
- Notifications
- Waiter calls
- KOT / KDS
- Realtime communication
- Authentication / session handling
- Routing / URL handling
- Database schema
- API/server actions
- RBAC / tenant / branch isolation

Do NOT create a second CRM, second loyalty engine, second billing engine, second notification system, or duplicate customer/order logic.

Reuse the existing authoritative systems wherever they already exist.

The goal is to make the entire flow production-grade, consistent, realtime, auditable, tenant-safe, branch-safe, duplicate-safe and easy for staff to use.

==================================================
1. CUSTOMER CRM
==================================================

Improve the existing Customer section into a proper flexible Customer CRM.

CUSTOMER CATEGORIES

Owner/Main Admin should be able to create custom customer categories.

Examples:
- Student
- Regular Customer
- VIP
- Corporate
- Tourist
- Family
- Staff
- Wholesale
- Any custom category

Do NOT hard-code these categories.

Category management should support:
- Create
- Edit
- Activate/deactivate
- Search
- Delete only when safe
- Prevent deletion if historical customer records depend on it, or use safe deactivation

A customer may have a category.

CUSTOMER CREATION

Add Customer should support:

Required:
- Phone number

Optional:
- Name
- Category
- Date of birth
- Anniversary date
- Email
- Address
- Notes
- Any existing supported customer fields

Do NOT make unnecessary fields mandatory.

Phone number should be normalized and unique within the correct tenant/customer scope.

Prevent accidental duplicate customers.

If the phone number already exists:
- Show the existing customer
- Do not silently create another customer
- Allow authorized staff to open/use the existing customer

If a new phone number is entered:
- Pre-fill that phone number into the Add Customer form
- Allow staff to complete the optional details

==================================================
2. CUSTOMER DETAILS PAGE
==================================================

When clicking a customer, show a complete customer profile.

Include:

PROFILE
- Name
- Phone
- Category
- Email
- DOB
- Anniversary
- Address
- Notes
- Created date
- Last visit
- Customer status

CUSTOMER ACTIVITY
- Total visits
- Total orders
- Total amount spent
- Average order value
- Last visit
- First visit
- Number of cancelled orders
- Number of refunded orders
- Loyalty points
- Rewards redeemed
- Outstanding amount if applicable

ORDER HISTORY

Show the customer's complete historical transactions.

Each transaction should show:
- Order number
- Date/time
- Branch
- Order type
- Items
- Quantity
- Discounts
- Service charge
- Tax
- Grand total
- Payment status
- Payment methods
- Refund information where applicable
- Loyalty earned/redeemed
- Staff/cashier where appropriate

Clicking an order should open the existing authoritative order/invoice details.

Do NOT duplicate billing calculations.

Customer insights must read from the existing order/payment/billing systems.

==================================================
3. CUSTOMER INSIGHTS
==================================================

Create/improve Customer Insights.

Show useful customer analytics such as:

- Total customers
- New customers
- Returning customers
- Repeat customers
- Regular customers
- Inactive customers
- Total visits
- Total revenue from customers
- Average spend
- Top customers by spend
- Top customers by visit count
- Loyalty activity

IMPORTANT:

Do not invent separate calculations.

Use the authoritative order/payment/refund definitions already used by TableFlow reporting.

Revenue must remain consistent with the existing accounting/reporting engine.

CUSTOMER FILTERING

Allow filtering by:

- Date range
- Branch/location
- Category
- Visit count
- Total spending
- Last visit
- First visit
- Loyalty points
- Active/inactive
- New customer
- Returning customer
- Repeat customer
- Regular customer

Example:

Customers who:
- visited more than 5 times
- spent more than LKR 50,000
- belong to Student category
- have not visited for 30 days
- visited during a selected date range

Use server-side filtering/querying for large datasets.

Do not load the entire customer database into the browser.

==================================================
4. FILTERED CUSTOMER DISCOUNTS
==================================================

From Customer Insights, authorized users should be able to select a filtered customer segment and create a discount campaign/action.

Example:

"Customers with 5+ visits"

Then:
Apply discount:
- Percentage
OR
- Fixed amount

Configure:
- Discount value
- Applicable menu items/categories if existing discount engine supports it
- Start date
- End date
- Minimum order if supported
- Maximum discount if supported
- Usage limit if supported

IMPORTANT:

Do NOT create a second discount engine.

Reuse the existing authoritative discount system.

Do not directly modify historical invoices.

A customer discount must only affect eligible future orders.

Every discount action must be permission-controlled and audited.

If the existing system supports promotional/customer-specific discounts, integrate with that system instead of creating another mechanism.

==================================================
5. POS CUSTOMER FLOW
==================================================

The POS customer flow must be extremely simple.

When creating an order from POS:

FIRST ASK FOR:
- Customer phone number

Then:

If phone exists:
- Automatically find customer
- Show customer name
- Show customer category
- Show loyalty points
- Show available rewards

Do not ask the cashier to enter the name again.

If phone does not exist:
- Show Add Customer option
- Phone number should already be filled
- Allow optional:
  - Name
  - Category
  - DOB
  - Anniversary
  - Email
  - Address
  - Notes

Use the SAME customer creation component/logic as the Customer CRM.

Do not build a separate POS customer database.

==================================================
6. "ADD CUSTOMER / ADD MEMBER" UI
==================================================

Use one shared customer form/component.

It should be usable from:

- Customer CRM
- POS
- Dine-in order
- Counter order
- Takeaway order
- Delivery order
- Loyalty flow

Button can be:
"Add Customer"
or
"Add Member"

depending on existing UI terminology.

All fields and validation must be consistent everywhere.

==================================================
7. LOYALTY IN POS
==================================================

When a customer is attached to a POS order, show:

- Current loyalty points
- Available rewards
- Points required
- Redeem option

Loyalty must remain OPTIONAL.

Cashier should be able to:
- Attach customer
- View points
- Redeem reward
- Continue without redeeming

Do not force loyalty usage.

Use the existing authoritative loyalty ledger/rules.

Points must only be earned according to the existing successful payment/completion rules.

Refund/cancellation must reverse loyalty correctly where applicable.

Redemption must be atomic and duplicate-safe.

Never allow negative loyalty balances.

==================================================
8. POS ORDER TYPES
==================================================

The same customer/payment/discount/loyalty/order architecture must work for:

- Dine-in
- Counter
- Takeaway
- Delivery

Do NOT create separate order engines.

Every order must continue through the same authoritative:

Customer
→ Order
→ Billing
→ Payment
→ Inventory/COGS
→ Reporting
→ Loyalty
→ Audit

flow.

==================================================
9. TAKEAWAY POS FLOW
==================================================

For Takeaway orders, provide:

- Send to Kitchen
- Bill
- Payment

The cashier should be able to:

1. Select customer
2. Select food/items
3. Apply item/order discounts where authorized
4. Review order
5. Send to Kitchen
6. Prepare bill
7. Accept payment
8. Complete order

Do not require unnecessary steps.

Payment must use the existing manual payment system.

NO REAL PAYMENT GATEWAY.

Allowed existing manual payment methods may include:
- Cash
- Card
- QR
- Online
- Wallet
- Bank Transfer
- Other

These are payment recording methods only.

==================================================
10. INDIVIDUAL ITEM DISCOUNTS
==================================================

For ANY cashier-created order:

- Dine-in
- Counter
- Takeaway
- Delivery

After selecting food items, each individual line/item should have an authorized discount option.

Example:

Burger
Qty: 2
Unit price: 1,000
Item discount: 100

Fries
Qty: 1
Unit price: 500
No discount

The order should clearly show:

Item price
Item discount
Net item amount

Then calculate:

Subtotal
→ Discounts
→ Loyalty
→ Service Charge
→ Tax
→ Rounding
→ Grand Total

Use the existing authoritative billing engine.

Do NOT calculate totals independently inside the POS UI.

Discount permissions and limits must remain enforced server-side.

No unlimited unauthorized discounts.

Every manual discount must be auditable.

==================================================
11. SPLIT PAYMENT
==================================================

IMPORTANT:

Split payment means splitting the MONEY, NOT splitting food/items.

Example:

Grand Total = LKR 10,000

Customer can pay:
- Cash = 4,000
- Card = 3,000
- QR = 3,000

OR any valid combination.

Do NOT split the order's food items between payments.

The original order remains one order.

Use the existing payment architecture.

Requirements:
- Exact amount validation
- Partial payments
- Multiple payment methods
- Remaining balance
- Overpayment protection
- Payment history
- Refund compatibility
- Audit trail
- Duplicate-safe transaction handling

Do not allow the UI to create inconsistent payment totals.

==================================================
12. HOLD PAYMENT / UNPAID ORDERS
==================================================

If a cashier wants to hold an order/payment:

Customer identification is REQUIRED.

At minimum:
- Name
- Phone number

Do not allow anonymous held orders.

If customer already exists:
- Automatically load the customer

If new:
- Create customer using the shared customer flow

Held order must remain linked to:
- Customer
- Order
- Branch
- Cashier
- Date/time
- Items
- Amount
- Payment status

Held orders must be recoverable safely.

==================================================
13. POS UI LAYOUT
==================================================

Improve the POS layout.

Make the food/menu item selection area slightly smaller.

Make the order details/cart column slightly larger.

The larger order column must comfortably show:

- Customer
- Phone
- Category
- Loyalty points
- Loyalty redemption
- Items
- Item quantities
- Item discounts
- Order discount
- Subtotal
- Service charge
- Tax
- Grand total
- Payment status
- Payment methods
- Remaining balance

Keep the interface clean.

Do not overcrowd it.

Make the important order information immediately visible.

==================================================
14. REALTIME NOTIFICATION SYSTEM — CRITICAL
==================================================

There are currently cases where notifications only appear after refreshing.

FIX THE UNDERLYING REALTIME ARCHITECTURE.

Do NOT solve this by simply adding aggressive polling.

Inspect the existing realtime/event architecture first.

All important events must appear live without page refresh.

Examples:

WAITER CALLS
- Customer calls waiter
- Bill request
- Extra plate
- Water
- General waiter request
- Any other waiter-call type

All should generate a realtime event.

AUTHORIZED WAITER STAFF should immediately receive a prominent popup.

Popup should include:
- Branch
- Table
- Request type
- Time
- Who/where it came from if available
- Acknowledge
- Resolve

The popup should appear even if the staff member is currently on another page within the application.

==================================================
15. ALL NOTIFICATIONS MUST BE REALTIME
==================================================

Do not limit realtime fixes to waiter calls.

Audit ALL notification/event types.

Examples:

- Customer waiter calls
- Bill requests
- Extra plate requests
- KOT created
- New kitchen order
- Order accepted
- Order rejected
- Order status changes
- Item prepared
- Item served
- Order ready
- Payment events
- Refund events
- Approval requests
- Stock transfer events
- Transfer dispatched
- Transfer received
- Shift handover
- Tasks
- System alerts
- Any existing notification types

Every notification must have:

- Event source
- Event type
- Tenant
- Branch
- Target audience
- Created timestamp
- Read/unread state
- Acknowledged/resolved state where applicable
- Audit information

==================================================
16. REALTIME RELIABILITY
==================================================

Implement/fix the realtime architecture properly.

Requirements:

- Event emitted only after successful database transaction commit
- Correct tenant isolation
- Correct branch/user audience
- Reconnect automatically
- Handle temporary network loss
- Resubscribe after reconnect
- Do not duplicate events
- Do not lose events silently
- Idempotent event handling
- Ordered state updates where required
- Notification history remains available
- Unread notification count updates live
- Popup appears live
- Existing open pages update without refresh

If the project already uses a realtime provider, inspect and repair it.

If it uses a database event/outbox architecture, reuse it.

Do NOT introduce another realtime framework unnecessarily.

Use transactional outbox/event patterns where appropriate.

IMPORTANT:

Do not use database polling every few seconds as the primary solution.

Polling may only be a controlled fallback if the existing architecture absolutely requires it.

==================================================
17. NOTIFICATION POPUP SYSTEM
==================================================

Create/reuse one global notification listener.

It should work regardless of which page the user is viewing.

For example:

Cashier is on POS
→ waiter calls
→ popup immediately appears.

Kitchen is viewing KDS
→ approval/KOT event applicable to that user
→ popup appears.

Manager is on Dashboard
→ stock approval request
→ popup appears.

Do not require navigation or refresh.

Use a shared notification/toast/modal system rather than implementing separate popup logic on every page.

Respect RBAC and branch permissions.

Users must NEVER receive another tenant's notifications.

==================================================
18. FIX 0.0.0.0 / REFRESH / SESSION BUG
==================================================

There is a serious production navigation issue.

Sometimes refreshing the application causes the browser URL/tab to become something like:

0.0.0.0

Then the user must manually re-enter the correct URL and log in again.

Investigate the ROOT CAUSE.

Inspect:

- Next.js configuration
- Host configuration
- Render configuration
- Environment variables
- NEXT_PUBLIC_APP_URL
- Server host binding
- PORT handling
- Middleware
- Authentication redirects
- Session/cookie configuration
- Absolute URL generation
- WebSocket/realtime URLs
- PWA/service worker
- Manifest
- Redirects
- Proxy headers
- X-Forwarded-Host
- X-Forwarded-Proto
- Any hard-coded localhost / 0.0.0.0 URL
- Any development-only URL accidentally used in production

Production must NEVER redirect users to:

0.0.0.0
localhost
127.0.0.1
internal server hostname
development URL

Use the correct public application URL from environment/configuration.

Refresh should:
- Keep the correct URL
- Keep the session
- Keep authentication
- Restore the correct page
- Not force unnecessary login
- Not break deep links

Make the fix production-safe.

Do not hard-code the production URL into random components.

Use a single canonical application URL configuration.

==================================================
19. STOCK ITEM EDIT BUG — CRITICAL
==================================================

There is currently a bug:

User edits a stock item, for example:
- price
- name
- unit
- category
- other editable information

Clicks Save.

UI says:
"Item saved"

But after refresh the old values remain.

Investigate the COMPLETE save path:

UI form
→ validation
→ API/server action
→ authorization
→ database update
→ transaction
→ cache
→ query invalidation
→ frontend state

Find the actual root cause.

Potential causes to inspect:

- Wrong ID
- Wrong database record
- Update action not executed
- PATCH/PUT mismatch
- Server action issue
- Prisma update issue
- Transaction rollback
- Validation silently dropping fields
- Incorrect field mapping
- Stale React/query cache
- Revalidation problem
- Optimistic UI incorrectly showing success
- Database update returning stale data
- Branch/tenant filter preventing update
- Wrong form state
- Number/Decimal conversion problem

DO NOT simply change the success message.

The system should only show success after the database update is actually committed.

After save:
1. Persist to DB.
2. Return updated authoritative record.
3. Refresh/invalidate relevant cache/query.
4. UI displays the saved DB state.
5. Browser refresh must still show the updated value.

Add regression tests for this.

IMPORTANT:

Respect existing inventory rules.

Do not allow editing historical inventory movements or financial history incorrectly.

If a field such as cost/base unit has historical locking rules, preserve those rules.

Only editable fields that are legitimately editable should be changed.

==================================================
20. CUSTOMER + POS + LOYALTY DATA CONSISTENCY
==================================================

Customer information must be one source of truth.

Customer created from:

Customer CRM
POS
Dine-in
Counter
Takeaway
Delivery
QR ordering

must become the SAME customer record when the phone matches.

Do not create duplicates.

Customer data must remain tenant-safe.

A customer from Restaurant A must NEVER appear in Restaurant B.

Branch permissions must be respected.

==================================================
21. DATA MODEL / DATABASE
==================================================

Before implementation, inspect the existing Prisma/database schema.

Reuse existing models where possible.

Only add/modify models when necessary.

Possible concepts include:

Customer
CustomerCategory
CustomerOrderHistory
CustomerInsight
LoyaltyLedger
LoyaltyReward
CustomerSegment
CustomerDiscount/Campaign
Notification
NotificationEvent
WaiterCall
Payment
Order
OrderItem

But DO NOT blindly create all of these if equivalent models already exist.

Use the existing architecture.

Add proper indexes for:

- tenant/restaurant
- branch
- phone
- customer category
- created date
- last visit
- order/customer relationships
- notification audience
- notification status
- event timestamp

Avoid N+1 queries.

Use pagination for large datasets.

==================================================
22. SECURITY / RBAC
==================================================

Everything must be server-side protected.

Do not rely only on hiding UI buttons.

Check:

- Tenant
- Restaurant
- Branch
- User
- Role
- Permission

for every sensitive action.

Examples:

Customer export
Customer discount campaign
Manual discount
Loyalty adjustment
Refund
Payment
Customer data editing
Notification access
Waiter call resolution
Stock editing

must be authorized server-side.

==================================================
23. AUDIT TRAIL
==================================================

Important actions must be auditable.

Examples:

- Customer created
- Customer edited
- Category changed
- Discount created
- Discount applied
- Loyalty redeemed
- Loyalty adjusted
- Payment added
- Payment held
- Payment completed
- Refund
- Waiter call
- Waiter call acknowledged
- Notification generated
- Stock item edited
- Permission changes

Record:
- User
- Timestamp
- Branch
- Action
- Entity
- Entity ID
- Before/after where appropriate
- Request/reference ID

==================================================
24. TESTING — DO NOT SKIP
==================================================

After implementation, test the COMPLETE flows.

CUSTOMER:
- Create customer
- Duplicate phone
- Edit customer
- View profile
- View order history
- Customer insights
- Filters
- Customer categories

POS:
- Existing customer lookup
- New customer
- Dine-in
- Counter
- Takeaway
- Delivery
- Item discount
- Order discount
- Loyalty points
- Loyalty redemption
- Split payment by money
- Held payment
- Payment completion

DISCOUNTS:
- Filter customer segment
- Create discount
- Apply to eligible customer
- Verify unauthorized users cannot create/apply

STOCK:
- Edit stock item
- Save
- Refresh
- Verify DB value
- Verify cache/UI
- Verify historical inventory integrity

REALTIME:
- Waiter call
- Bill request
- Extra plate
- Water request
- KOT
- New order
- Order status
- Approval
- Notification unread count
- Popup
- Reconnect after network interruption
- Multiple browser sessions
- Multiple branches
- Multiple users

URL/AUTH:
- Login
- Refresh
- Deep link
- Logout/login
- Session persistence
- Production URL
- No 0.0.0.0
- No localhost redirect

==================================================
25. FAILURE / RACE-CONDITION TESTING
==================================================

Intentionally test:

- Double-click Save
- Double-click payment
- Two users editing same customer
- Two users redeeming same loyalty reward
- Two staff responding to same waiter call
- Reconnect during notification
- Browser refresh during order
- Network disconnect during payment
- Duplicate event delivery
- Concurrent stock edit
- Concurrent customer creation using same phone
- Concurrent discount application

The system must remain consistent.

Use transactions/idempotency/unique constraints where appropriate.

==================================================
26. PERFORMANCE
==================================================

Customer Insights may contain thousands/millions of records.

Do NOT:

- Load all customers into browser
- Calculate all customer analytics in React
- Fetch every order individually
- Create N+1 queries

Use database-side aggregation and proper indexes.

Paginate customer lists and order history.

Use date ranges and filters server-side.

Realtime must not create excessive database load.

==================================================
27. UI/UX
==================================================

Keep the UI:

- Clean
- Professional
- Fast
- Simple
- Consistent with existing TableFlow design system
- Mobile/tablet friendly
- POS-friendly

Avoid unnecessary fields.

Avoid unnecessary popups.

Use clear labels.

Do not create duplicate navigation systems.

Reuse existing components/design patterns wherever possible.

==================================================
28. IMPLEMENTATION RULE
==================================================

Follow this exact process:

PHASE 1 — AUDIT

Inspect the entire existing implementation.

Identify:
- Existing customer models
- Existing customer UI
- Existing POS flow
- Existing loyalty system
- Existing billing engine
- Existing payment engine
- Existing notification system
- Existing realtime architecture
- Existing inventory update flow
- Existing authentication/session handling
- Existing deployment configuration

Create an internal implementation plan based on what already exists.

Do NOT start coding blindly.

PHASE 2 — ROOT CAUSE FIXES

Fix the existing bugs first:

1. 0.0.0.0 / refresh / authentication URL issue
2. Stock item save/update issue
3. Realtime notification reliability

Do not mask symptoms.

Fix the underlying architecture.

PHASE 3 — CUSTOMER CRM

Implement the unified customer/category/profile/insights system.

PHASE 4 — POS

Implement the unified customer lookup, customer creation, loyalty, item discounts, takeaway flow, held payment and split-money payment flow.

PHASE 5 — REALTIME

Make ALL applicable notifications live and reliable.

PHASE 6 — TESTING

Run:
- TypeScript checks
- Lint
- Unit tests
- Integration tests
- Existing project tests
- New regression tests
- Database tests
- Financial tests
- RBAC tests
- Tenant isolation tests
- Realtime tests
- Production build

Fix all failures.

==================================================
29. IMPORTANT ARCHITECTURAL RULES
==================================================

DO NOT create:

- Second customer system
- Second loyalty system
- Second billing engine
- Second payment engine
- Second discount engine
- Second notification system
- Second inventory engine
- Separate takeaway order engine

Everything must connect to the existing TableFlow architecture.

Customer:

Customer
→ Order
→ Billing
→ Payment
→ Inventory/COGS
→ Loyalty
→ Reports
→ Insights
→ Audit

Realtime:

Database transaction
→ committed event/outbox
→ realtime delivery
→ authorized user
→ live UI/popup
→ notification history

Never send a realtime event for a transaction that ultimately rolls back.

==================================================
30. FINAL REQUIREMENT
==================================================

After implementation, provide a concise final report containing:

1. What was already existing
2. What was changed
3. What bugs were fixed
4. Database/schema changes
5. Customer CRM changes
6. POS changes
7. Loyalty changes
8. Discount changes
9. Payment changes
10. Realtime/notification changes
11. Authentication/0.0.0.0 fix
12. Stock edit fix
13. Tests added
14. Tests executed
15. Any remaining issues
16. Any migration required
17. Any environment variables required
18. Any deployment considerations

MOST IMPORTANT:

Do not tell me that something is fixed merely because the UI displays success.

Verify the actual database state, server response, cache state and browser refresh behavior.

Do not weaken existing financial, inventory, accounting, tenant isolation, RBAC, loyalty, payment, audit or security rules.

Do not use real payment gateways.

Do not use fake/mock implementations for production functionality.

Do not modify production data directly.

Do not use destructive database commands.

Do not use `prisma db push` against production.

Preserve existing data and historical financial records.

Make the implementation production-ready and regression-safe.