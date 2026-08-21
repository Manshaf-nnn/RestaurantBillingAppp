# TABLEFLOW — ADVANCED RESTAURANT POS, ERP & INVENTORY MANAGEMENT SYSTEM
# MASTER IMPLEMENTATION PROMPT

ROLE

Act as a senior restaurant POS architect, ERP architect, inventory-management specialist, database architect, and full-stack engineer.

You are working on the existing TableFlow restaurant management application.

The goal is NOT to create a simple POS.

Transform the existing system into a production-grade, multi-tenant restaurant POS + inventory + procurement + warehouse + production + branch management system.

IMPORTANT:

DO NOT create disconnected features.

Every module must be interconnected.

Do not duplicate business logic between modules.

Do not rely only on frontend calculations.

All important inventory, financial, permission, and business rules must be enforced server-side and at database/transaction level where appropriate.

DO NOT remove existing working functionality.

DO NOT unnecessarily redesign the existing UI.

First inspect the existing project, database schema, Prisma schema, API routes, services, authentication, authorization, inventory logic, recipe logic, order logic, purchase logic, and reporting logic.

Reuse existing structures where possible.

Before changing anything:

1. Inspect the current architecture.
2. Identify existing models.
3. Identify existing APIs.
4. Identify existing inventory logic.
5. Identify existing recipe logic.
6. Identify existing order flow.
7. Identify existing authentication and roles.
8. Identify existing branch/restaurant structures.
9. Identify what already works.
10. Identify what is missing.
11. Create a safe implementation plan.
12. Then implement the required system.

Do not assume something exists simply because a UI exists.


============================================================
1. CORE BUSINESS STRUCTURE
============================================================

TableFlow must support multiple restaurants.

Example:

Restaurant A
ABC Restaurant

Restaurant B
XYZ Restaurant


Each restaurant is a completely isolated tenant.

Restaurant A must never access Restaurant B data.

Every business record must be associated with the correct restaurant/tenant.

Core hierarchy:

RESTAURANT
    ↓
BRANCH
    ↓
STORAGE / WAREHOUSE
    ↓
INVENTORY
    ↓
PRODUCT / RAW MATERIAL
    ↓
RECIPE
    ↓
PRODUCTION
    ↓
SALES


But the system must also support:

RESTAURANT
    ↓
CENTRAL WAREHOUSE
    ↓
BRANCH
    ↓
STORAGE
    ↓
KITCHEN


And:

SUPPLIER
    ↓
PURCHASE
    ↓
WAREHOUSE
    ↓
PRODUCTION
    ↓
FINISHED GOODS
    ↓
BRANCH
    ↓
SALE


Everything must connect through the stock ledger.


============================================================
2. RESTAURANT / TENANT
============================================================

Restaurant fields should support:

- id
- name
- legal/business name
- logo
- contact information
- address
- currency
- timezone
- active status
- created date

All data must be tenant-isolated.


============================================================
3. BRANCH MANAGEMENT
============================================================

A restaurant can have multiple branches.

Example:

ABC Restaurant

- Colombo
- Kandy
- Galle

Branch fields:

- id
- restaurantId
- name
- address
- phone
- manager
- operating hours
- active status

Owner can switch between:

ALL BRANCHES
COLOMBO
KANDY
GALLE


All dashboards and reports must respect the selected branch.


============================================================
4. CENTRAL WAREHOUSE
============================================================

Support a central warehouse that belongs to a restaurant.

Example:

ABC Central Warehouse

The central warehouse can:

- receive supplier purchases
- store raw materials
- store packaging
- store finished products
- dispatch stock to branches
- receive stock from branches
- transfer stock to production
- receive finished products from production


Central warehouse must have its own inventory context.

Do not mix central warehouse inventory with branch inventory.


============================================================
5. STORAGE LOCATIONS
============================================================

Each branch or warehouse can have multiple storage locations.

Example:

Colombo:

- Main Store
- Cold Room
- Freezer
- Kitchen Store
- Bar Store
- Dry Store

Kandy:

- Main Store
- Cold Room
- Freezer
- Kitchen Store

Central Warehouse:

- Main Warehouse
- Cold Storage
- Freezer
- Packaging Store

Production:

- Raw Material Store
- Production Area
- Finished Goods Store


Inventory must know:

restaurant
branch
warehouse
storage location
item


Do not treat the entire restaurant as one inventory bucket.


============================================================
6. ITEM / PRODUCT MASTER
============================================================

Support different item types.

Examples:

RAW_MATERIAL
INGREDIENT
PACKAGING
FINISHED_GOOD
MENU_ITEM
SEMI_FINISHED
PRODUCTION_ITEM
SERVICE

Examples:

Chicken Patty
Bun
Cheese
Chicken Meat
Oil
Seasoning
Burger
Pizza
Coke
Takeaway Box


Item fields should support:

- name
- SKU
- barcode
- category
- unit
- purchase unit
- selling unit
- conversion factor
- cost
- selling price
- tax if applicable
- active status
- stock tracking
- expiry tracking where applicable
- batch tracking where applicable


============================================================
7. UNITS OF MEASUREMENT
============================================================

Support units such as:

- kg
- g
- L
- ml
- pcs
- box
- packet
- bottle
- tray

Support conversions.

Example:

1 kg = 1000 g

1 box = 24 bottles

Purchasing may happen in:

BOX

while consumption happens in:

PCS


The inventory engine must correctly convert units.


============================================================
8. SUPPLIER MANAGEMENT
============================================================

Supplier fields:

- name
- contact person
- phone
- email
- address
- tax details if applicable
- payment terms
- active status

Example:

ABC Foods


Supplier relationships must connect to:

Purchases
Purchase Orders
Goods Receipts
Purchase Returns
Supplier balances
Inventory cost


============================================================
9. PROCUREMENT WORKFLOW
============================================================

Support:

PURCHASE REQUEST
    ↓
PURCHASE ORDER
    ↓
SUPPLIER
    ↓
GOODS RECEIPT
    ↓
QUALITY CHECK if applicable
    ↓
WAREHOUSE INVENTORY


IMPORTANT:

Creating a purchase order must NOT increase inventory.

Inventory increases only when goods are actually received.

Example:

PO:

50 Chicken Patties

Before receipt:

Stock = 100

After PO:

Stock = 100

After receiving 50:

Stock = 150


Partial receiving must be supported.

Example:

Ordered = 100

Received = 60

Remaining = 40


============================================================
10. PURCHASE RETURN
============================================================

Support purchase returns.

Example:

Received:

50

Return:

10

Expected:

Inventory decreases by 10.

Record:

supplier
items
quantity
reason
user
date
stock ledger transaction


============================================================
11. INVENTORY ENGINE
============================================================

Inventory is the core of the system.

Every stock movement must create a stock ledger transaction.

Do NOT simply update inventory.quantity without creating a corresponding ledger transaction.


============================================================
12. STOCK LEDGER
============================================================

Create/use a central stock ledger.

Every inventory movement must record:

- id
- restaurantId
- branchId
- warehouseId
- storageLocationId
- itemId
- transactionType
- referenceType
- referenceId
- quantity
- unitCost
- totalCost
- quantityBefore
- quantityAfter
- userId
- timestamp
- reason
- notes

Transaction types should cover the existing business requirements, such as:

OPENING_BALANCE
PURCHASE_RECEIPT
PURCHASE_RETURN
SALE
SALE_REVERSAL
WASTAGE
STOCK_ADJUSTMENT
TRANSFER_OUT
TRANSFER_IN_TRANSIT
TRANSFER_IN
PRODUCTION_CONSUMPTION
PRODUCTION_OUTPUT
CUSTOMER_RETURN

Do not create duplicate or conflicting transaction types if the existing system already has appropriate enums.

The stock ledger should be treated as the authoritative history of stock movements.


============================================================
13. INVENTORY QUANTITIES
============================================================

Where required, distinguish:

AVAILABLE
RESERVED
IN_TRANSIT
DAMAGED
WASTED

Example:

Colombo:

Available = 70

Kandy:

In Transit = 30

After receiving:

Kandy Available = 30


Do not count IN_TRANSIT stock as available stock.


============================================================
14. INVENTORY FORMULA
============================================================

Inventory must reconcile according to:

Opening Stock
+ Purchase Receipts
+ Production Output
+ Transfer In
+ Customer Returns
- Sales Consumption
- Production Consumption
- Transfer Out
- Wastage
- Purchase Returns
± Adjustments

=

Current Stock


The system must be able to reconcile current inventory against the stock ledger.


============================================================
15. RECIPE MANAGEMENT
============================================================

Recipes are central to the restaurant system.

Example:

Chicken Burger

1 Chicken Patty
1 Bun
1 Cheese


Recipe must support:

- ingredients
- quantity
- unit
- yield
- wastage percentage if applicable
- preparation instructions
- recipe version
- effective date
- active status


============================================================
16. RECIPE VERSIONING
============================================================

Never change historical recipes for completed sales.

Example:

Version 1:

Chicken Patty = 1

Sale happens.

Later:

Version 2:

Chicken Patty = 0.8


Old sale must continue to reference Version 1.

New sale must use Version 2.

Store recipe version/snapshot against the transaction.


============================================================
17. MENU ITEM + RECIPE
============================================================

A menu item can have a recipe.

Example:

Chicken Burger
Selling price = Rs. 1,200

Recipe:

Chicken Patty = 1
Bun = 1
Cheese = 1


When customer purchases:

3 Chicken Burgers

Automatically consume:

Chicken Patty = 3
Buns = 3
Cheese = 3


Create stock ledger entries for each ingredient.


============================================================
18. PRODUCTION HOUSE
============================================================

TableFlow must support a dedicated Production House.

Production House is interconnected with:

RAW MATERIALS
RECIPES
PRODUCTION BATCHES
FINISHED GOODS
WAREHOUSE
BRANCHES
STOCK LEDGER
COGS


Example:

ABC Production House


Production workflow:

RAW MATERIALS
    ↓
PRODUCTION RECIPE
    ↓
PRODUCTION BATCH
    ↓
RAW MATERIAL CONSUMPTION
    ↓
FINISHED GOODS OUTPUT
    ↓
FINISHED GOODS STORAGE


============================================================
19. PRODUCTION RECIPE
============================================================

Example:

Chicken Burger Patty

Recipe:

Chicken Meat = 0.20 kg
Seasoning = 0.02 kg
Oil = 0.01 L

Output:

1 Chicken Patty


If producing:

50 Chicken Patties


Consume:

Chicken Meat = 10 kg
Seasoning = 1 kg
Oil = 0.5 L


Produce:

Chicken Patty = 50


Create:

PRODUCTION_CONSUMPTION

for raw materials.

Create:

PRODUCTION_OUTPUT

for finished goods.


============================================================
20. PRODUCTION COSTING
============================================================

Production cost should be calculated from consumed raw materials.

Example:

Chicken meat cost
+
Seasoning cost
+
Oil cost
+
other applicable production costs

=

Production batch cost


Finished product unit cost:

Total production cost / output quantity


Do not invent accounting logic that conflicts with the existing application.


============================================================
21. PRODUCTION BATCH
============================================================

Production batch should record:

- batch number
- production house
- recipe
- recipe version
- planned quantity
- actual quantity
- raw materials consumed
- finished goods produced
- production cost
- user
- date
- status


Statuses may include:

PLANNED
IN_PROGRESS
COMPLETED
CANCELLED


Only completed production should create final finished-good inventory.


============================================================
22. PRODUCTION → BRANCH
============================================================

Example:

Production House produces:

100 Chicken Patties

Then transfer:

20 Chicken Patties

Production House
→
Colombo Main Store


Workflow:

REQUESTED
APPROVED
DISPATCHED
IN_TRANSIT
RECEIVED
COMPLETED


At dispatch:

Production House available decreases by 20.

Colombo in-transit increases by 20.

At receipt:

Colombo available increases by 20.


============================================================
23. INTER-BRANCH TRANSFERS
============================================================

Example:

Colombo → Kandy

Transfer:

30 Chicken Patties


Workflow:

REQUESTED
APPROVED
DISPATCHED
IN_TRANSIT
RECEIVED
COMPLETED

or:

REJECTED
CANCELLED


Stock rules:

APPROVED:

No destination available stock increase.

DISPATCHED:

Source available decreases.

Destination in-transit increases.

RECEIVED:

Destination available increases.

COMPLETED:

Transfer is finalized.


============================================================
24. TRANSFER VARIANCE
============================================================

If:

Sent = 30

Received = 28

Then:

Variance = -2


Never silently ignore the difference.

Record:

sent quantity
received quantity
variance
reason
receiver
approval
timestamp


Source must remain reduced by 30.

Destination must increase by 28.

The missing 2 must be accounted for.


============================================================
25. INTERNAL STORAGE TRANSFERS
============================================================

Support transfers inside the same branch.

Example:

Colombo Main Store
→
Colombo Cold Room


This must also use the stock ledger.

Do not treat internal transfers as invisible inventory changes.


============================================================
26. WASTAGE
============================================================

Support wastage.

Example:

2 Chicken Patties wasted.

Inventory:

148 → 146


Record:

item
quantity
location
reason
cost
user
timestamp
ledger transaction


Examples of reasons:

EXPIRED
DAMAGED
SPOILED
OVERCOOKED
SPILLED
OTHER


============================================================
27. CUSTOMER RETURNS / SALE REVERSALS
============================================================

If a completed sale is cancelled:

Do not delete the sale.

Create a reversal.

Restore inventory according to the original recipe/version.

Create SALE_REVERSAL ledger entries.

Reverse appropriate COGS.

Preserve the original transaction.


============================================================
28. ORDER → KITCHEN → SALE → INVENTORY
============================================================

Customer flow:

QR / POS
    ↓
ORDER
    ↓
ORDER ITEMS
    ↓
KITCHEN
    ↓
PREPARATION
    ↓
SERVED
    ↓
PAYMENT
    ↓
SALE COMPLETED
    ↓
RECIPE CONSUMPTION
    ↓
STOCK LEDGER
    ↓
COGS


Inventory must not be deducted multiple times because of:

order creation
kitchen preparation
payment
order completion

Define one authoritative inventory-consumption event and ensure it is idempotent.


============================================================
29. DUPLICATE REQUEST PROTECTION
============================================================

Same request submitted twice must not create duplicate business effects.

Protect:

orders
payments
stock deductions
transfers
receipts
production batches


Use the appropriate combination of:

unique constraints
idempotency keys
transaction checks
server-side validation


============================================================
30. CONCURRENT SALES
============================================================

Protect against race conditions.

Example:

Chicken Patty = 1

Two customers simultaneously purchase Chicken Burger.

Only one transaction may consume the final patty.

The other must fail safely unless negative inventory is explicitly enabled.

Never allow:

-1

or other impossible stock values accidentally.


============================================================
31. ATOMIC TRANSACTIONS
============================================================

Multi-item inventory operations must be atomic.

Example:

Chicken Burger requires:

Patty
Bun
Cheese


If Patty is deducted successfully but Bun fails:

ROLL BACK EVERYTHING.

Do not leave partial stock deductions.


============================================================
32. NEGATIVE INVENTORY
============================================================

Default behavior:

Negative inventory is NOT allowed.

Prevent:

selling unavailable stock
transferring unavailable stock
wasting unavailable stock
producing without ingredients


If the existing application explicitly supports negative inventory, preserve that business rule and make it configurable.


============================================================
33. INVENTORY RESERVATION
============================================================

If the existing ordering workflow supports reservation:

When required:

AVAILABLE
→
RESERVED

After confirmation:

RESERVED
→
CONSUMED

After cancellation:

RESERVED
→
AVAILABLE


Do not double-consume reserved stock.


============================================================
34. LOW STOCK
============================================================

Support stock thresholds where already applicable.

Example:

Chicken Patty

Minimum = 20

Current = 15

Show:

LOW STOCK


Branch-specific inventory thresholds must be respected.


============================================================
35. MULTI-BRANCH DASHBOARD
============================================================

Owner can select:

ALL BRANCHES
COLOMBO
KANDY
GALLE


For ALL BRANCHES show aggregated:

Sales
Purchases
Inventory
Inventory value
COGS
Gross profit
Wastage
Transfers
Production
Low stock


When a branch is selected:

Only that branch's data should be shown.


============================================================
36. CENTRAL WAREHOUSE DASHBOARD
============================================================

Show:

Total inventory
Inventory value
Incoming transfers
Outgoing transfers
Pending receipts
Low stock
Purchases
Production supply
Branch demand


============================================================
37. PRODUCTION DASHBOARD
============================================================

Show:

Production batches
Planned production
Completed production
Raw material consumption
Finished goods
Production cost
Production house stock
Pending production


============================================================
38. PROCUREMENT DASHBOARD
============================================================

Show:

Pending purchase orders
Partially received orders
Completed purchases
Supplier spending
Purchase returns
Outstanding supplier balances if implemented


============================================================
39. INVENTORY REPORTING
============================================================

Inventory reports:

Current stock
Stock valuation
Stock movement
Stock ledger
Low stock
Wastage
Adjustments
Transfers
Production consumption
Production output
Purchase receipts
Purchase returns
Sales consumption


Allow filtering by:

Restaurant
Branch
Warehouse
Storage
Item
Category
Date


============================================================
40. COGS
============================================================

COGS must be connected to actual inventory consumption.

For menu sales:

Recipe ingredient consumption
→
Ingredient cost
→
COGS


For production:

Raw material consumption
→
Production cost
→
Finished product cost


Do not calculate COGS only from selling price.


============================================================
41. FOOD COST
============================================================

For each menu item calculate where supported:

Ingredient cost
Selling price
Food cost percentage
Gross margin


Example:

Selling price = Rs. 1,200

Ingredient cost = Rs. 450

Food cost %:

450 / 1200 × 100


Historical sales should retain the correct historical cost/recipe information according to the application's costing design.


============================================================
42. PROFITABILITY
============================================================

Reports should connect:

Sales revenue
-
discounts/refunds where applicable
-
COGS
=
Gross Profit


Support reporting by:

Restaurant
Branch
Menu item
Category
Date


============================================================
43. AUDIT LOG
============================================================

Sensitive operations must be auditable.

Record:

who
what
when
entity
entity ID
before value
after value
reason


Actions include:

purchase
receive
return
sale
sale cancellation
wastage
stock adjustment
transfer request
transfer approval
transfer dispatch
transfer receipt
production
recipe change
branch change
permission change


Do not allow users to silently modify historical financial/inventory events.


============================================================
44. ROLE-BASED ACCESS CONTROL
============================================================

Support appropriate existing roles.

OWNER:

Can access all restaurant branches and business data.

ADMIN:

Can manage permitted restaurant configuration.

MANAGER:

Can access assigned branch.

WAREHOUSE STAFF:

Can access assigned warehouse/storage.

KITCHEN STAFF:

Can access permitted kitchen/production/order operations.

CASHIER:

Can access permitted sales/payment functions.

USER:

Only permitted functions.


Permissions must be enforced server-side.

Do not rely on hiding buttons.


============================================================
45. BRANCH ISOLATION
============================================================

Example:

Colombo Manager

Must not access:

Kandy inventory
Kandy sales
Kandy purchases
Kandy transfers
Kandy customers

unless explicitly permitted.


Test both:

UI

and

direct API requests.


============================================================
46. TENANT ISOLATION
============================================================

Restaurant A:

ABC Restaurant

Restaurant B:

XYZ Restaurant


Restaurant A must NEVER access Restaurant B:

orders
customers
inventory
recipes
suppliers
purchases
branches
warehouses
production
transfers
reports
users


Even if a user manually changes an ID in an API request, access must be denied.


============================================================
47. DATABASE INTEGRITY
============================================================

Use appropriate:

foreign keys
unique constraints
indexes
transactions
status constraints
tenant constraints


Avoid orphan records.

Avoid duplicate stock movements.

Avoid duplicate payments.

Avoid duplicate production batches.

Avoid duplicate transfer effects.


============================================================
48. STOCK RECONCILIATION
============================================================

The system must be able to calculate:

Opening Stock
+
Purchase Receipts
+
Production Output
+
Transfer In
+
Customer Returns
-
Sales Consumption
-
Production Consumption
-
Transfer Out
-
Wastage
-
Purchase Returns
+
/-
Adjustments

=

Current Stock


Reconcile independently for:

restaurant
branch
warehouse
storage location
item


The result must match actual inventory.


============================================================
49. COMPLETE BUSINESS FLOW
============================================================

The complete intended business flow is:

SUPPLIER
    ↓
PURCHASE ORDER
    ↓
GOODS RECEIPT
    ↓
CENTRAL WAREHOUSE
    ↓
PRODUCTION HOUSE
    ↓
RAW MATERIAL CONSUMPTION
    ↓
FINISHED GOODS
    ↓
FINISHED GOODS STORAGE
    ↓
BRANCH TRANSFER
    ↓
BRANCH WAREHOUSE
    ↓
KITCHEN
    ↓
CUSTOMER ORDER
    ↓
RECIPE
    ↓
INGREDIENT CONSUMPTION
    ↓
STOCK LEDGER
    ↓
COGS
    ↓
PAYMENT
    ↓
SALES REPORT
    ↓
PROFIT REPORT


Parallel inventory flow:

CENTRAL WAREHOUSE
        ↓
   ┌────┴────┐
   ↓         ↓
Colombo     Kandy
   ↓         ↓
Storage    Storage
   ↓         ↓
Kitchen    Kitchen


Production flow:

RAW MATERIAL
     ↓
PRODUCTION RECIPE
     ↓
PRODUCTION BATCH
     ↓
RAW MATERIAL CONSUMPTION
     ↓
FINISHED PRODUCT
     ↓
PRODUCTION STORAGE
     ↓
BRANCH TRANSFER
     ↓
BRANCH STOCK


Sales flow:

CUSTOMER
     ↓
ORDER
     ↓
KITCHEN
     ↓
SERVED
     ↓
PAYMENT
     ↓
SALE
     ↓
RECIPE CONSUMPTION
     ↓
STOCK LEDGER
     ↓
COGS


============================================================
50. EXAMPLE COMPLETE SCENARIO
============================================================

Restaurant:

ABC Restaurant

Branches:

Colombo
Kandy

Central Warehouse:

ABC Central Warehouse

Production:

ABC Production House

Supplier:

ABC Foods


Initial Colombo inventory:

Chicken Patty = 100
Buns = 100
Cheese = 100


Purchase:

50 Chicken Patties

Receive:

50

Expected:

Chicken Patty = 150


Sale:

3 Chicken Burgers

Recipe:

1 Patty
1 Bun
1 Cheese


Consumption:

3 Patty
3 Bun
3 Cheese


Expected:

Patty = 147
Bun = 97
Cheese = 97


Cancel 1 burger:

Patty = 148
Bun = 98
Cheese = 98


Wastage:

2 Patty

Expected:

Patty = 146


Production:

Produce 50 Chicken Patties.

Raw materials are consumed according to production recipe.

Finished goods increase by 50.


Transfer:

20 Chicken Patties

Colombo → Kandy


After dispatch:

Colombo decreases by 20.

Kandy in-transit = 20.


After receipt:

Kandy available = 20.


Every one of these actions must appear in the stock ledger.


============================================================
51. IMPLEMENTATION RULE
============================================================

Do not implement the modules independently.

The relationships must be:

PURCHASE
→
INVENTORY
→
STOCK LEDGER


PRODUCTION
→
RAW MATERIAL INVENTORY
→
STOCK LEDGER
→
FINISHED GOODS INVENTORY


TRANSFER
→
SOURCE INVENTORY
→
IN-TRANSIT
→
DESTINATION INVENTORY
→
STOCK LEDGER


SALE
→
ORDER
→
RECIPE
→
INGREDIENT CONSUMPTION
→
STOCK LEDGER
→
COGS


WASTAGE
→
INVENTORY
→
STOCK LEDGER


CANCELLATION
→
REVERSAL
→
INVENTORY
→
STOCK LEDGER
→
COGS REVERSAL


REPORTS
must derive from the actual transactional data.


============================================================
52. IMPORTANT DEVELOPMENT RULES
============================================================

Do NOT:

- duplicate inventory calculations
- update stock only from frontend
- delete historical transactions
- silently alter old recipes
- silently ignore transfer variance
- allow duplicate requests to deduct stock twice
- allow unauthorized branch access
- allow cross-tenant access
- create inventory without a ledger transaction
- create production output without raw-material accounting
- count in-transit stock as available stock
- increase destination stock before transfer receipt
- allow partial transactions


Use:

- server-side validation
- database transactions
- atomic operations
- idempotency
- unique constraints
- proper foreign keys
- authorization checks
- immutable transaction history
- appropriate indexes


============================================================
53. IMPLEMENTATION PROCESS
============================================================

PHASE 1:

Inspect existing application.

Do not modify code yet.

Return:

- existing architecture
- existing database models
- existing inventory system
- existing recipe system
- existing order system
- existing purchase system
- existing branch system
- existing roles
- existing APIs
- missing components
- conflicts


PHASE 2:

Design the database/business relationships.

Show:

- entities
- relationships
- important constraints
- transaction boundaries


PHASE 3:

Implement the backend/domain logic.

Prioritize:

inventory
stock ledger
purchases
production
transfers
recipes
sales consumption
COGS
authorization


PHASE 4:

Connect existing UI to the backend.

Do not create fake frontend-only data.


PHASE 5:

Implement reporting based on actual transactional data.


PHASE 6:

Run comprehensive QA.

Test:

- purchases
- receiving
- sales
- cancellations
- wastage
- production
- transfers
- warehouse movement
- branch isolation
- tenant isolation
- recipe versioning
- duplicate requests
- concurrent sales
- negative stock
- atomic transactions
- stock reconciliation
- COGS
- reports
- audit


PHASE 7:

Fix every failure.

After each fix:

1. Retest failed scenario.
2. Run related regression tests.
3. Run full regression suite.


============================================================
54. FINAL ACCEPTANCE CRITERIA
============================================================

The system is considered complete only when:

1. Supplier purchases correctly increase inventory after receipt.

2. Purchase orders do not incorrectly increase inventory.

3. Sales consume recipe ingredients.

4. Cancellations correctly reverse consumption.

5. Wastage correctly decreases stock.

6. Production consumes raw materials and creates finished goods.

7. Production cost is calculated correctly.

8. Central warehouse works independently.

9. Branch warehouses work independently.

10. Storage locations work correctly.

11. Inter-branch transfers correctly support:
    REQUESTED
    APPROVED
    DISPATCHED
    IN_TRANSIT
    RECEIVED
    COMPLETED
    REJECTED
    CANCELLED

12. Transfer variance is recorded.

13. In-transit inventory is separated from available inventory.

14. Stock ledger records every stock movement.

15. Stock ledger reconciles with actual inventory.

16. Recipe versions preserve historical sales.

17. Duplicate requests do not duplicate transactions.

18. Concurrent sales cannot corrupt inventory.

19. Negative inventory is prevented unless explicitly enabled.

20. Transactions are atomic.

21. Restaurant tenants are isolated.

22. Branch permissions are enforced server-side.

23. Production, warehouse, branch, recipe, purchase, sale, and inventory systems are interconnected.

24. COGS is connected to actual inventory consumption.

25. Reports reconcile with transactional data.

26. Audit logs preserve sensitive actions.

27. Historical transactions are not silently modified.

28. No critical inventory, financial, security, or data-integrity issue remains.


============================================================
FINAL OUTPUT
============================================================

After implementation provide:

# TABLEFLOW ADVANCED SYSTEM IMPLEMENTATION REPORT

## Existing Architecture

## Changes Made

## Database Changes

## Inventory Engine

## Stock Ledger

## Supplier & Procurement

## Warehouse

## Storage Locations

## Production House

## Recipes & Recipe Versioning

## Branch Management

## Inter-Branch Transfers

## Sales & Inventory Consumption

## COGS

## Reports

## Permissions

## Tenant Isolation

## Audit

## Tests Executed

## Bugs Found

## Bugs Fixed

## Regression Results

## Remaining Issues

## Final Status

READY FOR PRODUCTION
or
NOT READY FOR PRODUCTION

Never claim something is working without actually verifying it.