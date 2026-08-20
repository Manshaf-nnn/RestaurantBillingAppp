IMPLEMENT PHASE 6 — MULTI-BRANCH, CENTRAL WAREHOUSE, PRODUCTION HOUSE & INTER-LOCATION INVENTORY MANAGEMENT

You are continuing development of the existing TableFlow restaurant POS SaaS.

IMPORTANT:
Do NOT rebuild the application.
Do NOT remove existing functionality.
Do NOT delete existing production data.
Do NOT create a separate disconnected inventory system.

The objective of this phase is to create a fully interconnected multi-location inventory architecture.

==================================================
1. CORE CONCEPT
==================================================

TableFlow must support different types of operational locations:

1. RESTAURANT BRANCH
2. PRODUCTION HOUSE
3. CENTRAL WAREHOUSE

All three must use the SAME inventory architecture and SAME stock ledger.

Example:

ABC RESTAURANT

                    ABC RESTAURANT
                          |
       -----------------------------------------
       |                  |                    |
Central Warehouse    Production House      Branches
                                            |
                              --------------------------
                              |            |            |
                           Colombo       Kandy        Galle


A production house is NOT simply a restaurant branch.

A production house is a facility that receives raw materials, produces/prepares intermediate or finished products, and distributes those products to branches or warehouses.

==================================================
2. LOCATION ARCHITECTURE
==================================================

Create a generic Location architecture.

A location should have:

- id
- restaurantId
- name
- type
- address
- phone
- manager
- operating hours
- active status
- createdAt
- updatedAt

LOCATION TYPES:

BRANCH
PRODUCTION_HOUSE
CENTRAL_WAREHOUSE

This allows the system to scale later without creating separate unrelated tables.

IMPORTANT:

All locations belonging to a restaurant must use the same restaurantId.

Restaurant A must NEVER access Restaurant B locations.

==================================================
3. EXAMPLES
==================================================

Restaurant:

ABC Restaurant

Locations:

1. Central Warehouse
   Type: CENTRAL_WAREHOUSE

2. Colombo Branch
   Type: BRANCH

3. Kandy Branch
   Type: BRANCH

4. Galle Branch
   Type: BRANCH

5. ABC Production House
   Type: PRODUCTION_HOUSE


==================================================
4. STORAGE LOCATIONS
==================================================

Every operational location can have multiple storage locations.

Example:

Colombo Branch:

- Main Store
- Cold Room
- Freezer
- Kitchen Store
- Bar Store

Production House:

- Raw Material Store
- Cold Storage
- Preparation Area
- Finished Goods Store
- Packaging Store

Central Warehouse:

- Main Warehouse
- Dry Store
- Cold Storage
- Freezer

Inventory must belong to:

Restaurant
→ Location
→ Storage Location
→ Inventory Item


Do NOT simply store inventory at branch level.

We need location-aware and storage-aware inventory.

==================================================
5. PRODUCTION HOUSE
==================================================

The Production House is a major feature.

It should support production/manufacturing workflows for restaurant ingredients and prepared products.

Examples:

Production House produces:

- Burger Patties
- Pizza Dough
- Burger Sauce
- Curry Base
- Gravy
- Marinated Chicken
- Prepared Vegetables
- Desserts
- Bottled Sauces
- Spice Mixes

These are inventory items that can be produced and then transferred to branches.

==================================================
6. RAW MATERIAL → PRODUCTION → FINISHED PRODUCT
==================================================

Example:

Production House receives:

Chicken = 100 kg
Spices = 10 kg
Oil = 20 L

Production recipe:

1 batch Chicken Patty

Uses:

Chicken = 10 kg
Spices = 1 kg
Oil = 500 ml

Produces:

100 Chicken Patties

When production is completed:

RAW MATERIAL STOCK DECREASES

Chicken -10 kg
Spices -1 kg
Oil -500 ml

FINISHED PRODUCT STOCK INCREASES

Chicken Patty +100 pcs

Both movements must be recorded in the stock ledger.

==================================================
7. PRODUCTION BATCH
==================================================

Create a Production Batch / Production Order.

Fields:

- productionOrderId
- restaurantId
- productionHouseId
- recipeId
- batchNumber
- plannedQuantity
- actualQuantity
- unit
- productionDate
- expiryDate if applicable
- requestedBy
- approvedBy
- startedAt
- completedAt
- status
- notes

STATUS:

DRAFT
PLANNED
APPROVED
IN_PROGRESS
COMPLETED
PARTIALLY_COMPLETED
CANCELLED

==================================================
8. PRODUCTION WORKFLOW
==================================================

Example:

Production House wants to produce:

500 Chicken Patties

Workflow:

DRAFT
    ↓
PLANNED
    ↓
APPROVED
    ↓
IN_PROGRESS
    ↓
COMPLETED


When production is completed:

1. Deduct required raw materials.
2. Add produced finished goods.
3. Create stock ledger entries.
4. Create production batch.
5. Calculate production cost.
6. Store batch number.
7. Store expiry date if applicable.

==================================================
9. PRODUCTION VARIANCE
==================================================

Example:

Planned:

500 patties

Actual:

480 patties

The system must record:

Planned = 500
Produced = 480
Variance = -20

Require a reason:

- Production loss
- Damaged
- Ingredient shortage
- Quality issue
- Other

Do not silently ignore production differences.

==================================================
10. PRODUCTION COSTING
==================================================

Calculate production cost.

Example:

Chicken = Rs. 20,000
Spices = Rs. 2,000
Oil = Rs. 1,000
Packaging = Rs. 500

Total production cost:

Rs. 23,500

Produced:

500 patties

Cost per patty:

Rs. 47

The produced inventory item should receive an appropriate cost.

Do not confuse this with selling price.

==================================================
11. PRODUCTION RECIPES
==================================================

Production recipes should be different from restaurant menu recipes conceptually.

Example:

PRODUCTION RECIPE:

Chicken Patty

Chicken Breast
Breadcrumbs
Spices
Oil

Produces:

100 Chicken Patties

MENU RECIPE:

Chicken Burger

Chicken Patty
Bun
Cheese
Lettuce
Sauce

Produces:

1 Chicken Burger

This creates:

RAW MATERIAL
      ↓
PRODUCTION RECIPE
      ↓
FINISHED PRODUCT
      ↓
MENU RECIPE
      ↓
CUSTOMER SALE

This entire chain must be supported.

==================================================
12. INTER-LOCATION TRANSFERS
==================================================

Create one unified transfer system.

Transfers can occur between:

Central Warehouse → Branch
Central Warehouse → Production House
Production House → Branch
Production House → Central Warehouse
Branch → Branch
Branch → Production House
Production House → Production House
Warehouse → Warehouse

Only allow transfers according to configured permissions/business rules.

==================================================
13. TRANSFER WORKFLOW
==================================================

REQUESTED
    ↓
APPROVED
    ↓
DISPATCHED
    ↓
IN_TRANSIT
    ↓
RECEIVED
    ↓
COMPLETED


Alternative:

REQUESTED
    ↓
REJECTED

or:

REQUESTED
    ↓
CANCELLED


==================================================
14. IMPORTANT STOCK RULE
==================================================

When transfer is REQUESTED:

NO STOCK CHANGE.

When APPROVED:

NO destination stock increase.

When DISPATCHED:

Source AVAILABLE stock decreases.

Destination IN_TRANSIT stock increases.

When RECEIVED:

Destination AVAILABLE stock increases.

IN_TRANSIT quantity decreases.

==================================================
15. TRANSFER EXAMPLE
==================================================

Colombo Branch:

Chicken Patty = 100

Transfer:

30 Chicken Patties

To:

Kandy Branch

After dispatch:

Colombo Available:
70

Kandy In Transit:
30

After receiving:

Kandy Available:
30

Kandy In Transit:
0


==================================================
16. TRANSFER VARIANCE
==================================================

Example:

Sent:

30

Received:

28

The system must record:

Sent = 30
Received = 28
Variance = -2

The receiver MUST provide a reason.

Example:

Damaged during transport

or:

Missing

or:

Other

Do NOT silently convert 30 into 28.

The system must preserve the original dispatch quantity.

==================================================
17. PRODUCTION HOUSE TRANSFER EXAMPLE
==================================================

Production House produces:

500 Chicken Patties

Finished Goods Store:

500 Chicken Patties

Production House sends:

200 to Colombo
200 to Kandy
100 remains at Production House


After dispatch:

Production House Available = 300
Colombo In Transit = 200
Kandy In Transit = 200

After branches receive:

Colombo = +200
Kandy = +200

Production House remaining:

100

Every movement must exist in the stock ledger.

==================================================
18. CENTRAL WAREHOUSE WORKFLOW
==================================================

Central Warehouse receives bulk materials.

Example:

Supplier delivers:

500 kg Chicken
200 kg Flour
100 kg Cheese

Central Warehouse stock increases.

Then:

Central Warehouse
        |
        |--------------------|
        ↓                    ↓
Production House         Branches

Production House receives raw materials.

Branches receive direct stock where required.

==================================================
19. PRODUCTION HOUSE → BRANCH
==================================================

Support direct distribution.

Example:

Production House produces:

1,000 Burger Patties

Distribution:

Colombo = 300
Kandy = 250
Galle = 200
Production House = 250

Create individual transfer records.

Do not simply change branch stock manually.

==================================================
20. BRANCH INVENTORY
==================================================

Each branch should be able to see:

Available Stock
Reserved Stock
In Transit
Low Stock
Out of Stock
Expired
Wastage
Stock Value

Example:

Chicken Patty:

Available: 120
In Transit: 50
Reserved: 10

Total physical/owned quantity must be calculated consistently.

Clearly distinguish:

AVAILABLE
RESERVED
IN_TRANSIT

Do not mix these values.

==================================================
21. STOCK LEDGER
==================================================

ALL inventory changes must go through the same stock ledger.

Transaction types should include:

OPENING_BALANCE
PURCHASE
SALE
PRODUCTION_CONSUMPTION
PRODUCTION_OUTPUT
WASTAGE
ADJUSTMENT_IN
ADJUSTMENT_OUT
TRANSFER_OUT
TRANSFER_IN
CUSTOMER_RETURN
SUPPLIER_RETURN

Every transaction must contain:

- id
- restaurantId
- locationId
- storageLocationId
- inventoryItemId
- quantity
- unit
- transactionType
- referenceType
- referenceId
- batchId if applicable
- userId
- createdAt
- notes

The ledger is the source of truth.

==================================================
22. BATCH TRACKING
==================================================

Production output should support batch numbers.

Example:

PAT-20260820-001

Chicken Patties
Quantity: 500
Production date: 20 Aug 2026
Expiry: 23 Aug 2026

When transferred:

The batch should remain traceable.

Example:

Production Batch:
PAT-20260820-001

Transferred:

200 → Colombo
150 → Kandy

The system should know exactly where that batch went.

==================================================
23. EXPIRY TRACKING
==================================================

For products requiring expiry:

Show:

Expired
Expires Today
Expires in 3 Days
Expires in 7 Days

Production House should be able to define shelf life.

Example:

Production:

20 Aug

Shelf life:

3 days

Expiry:

23 Aug

When transferred to branch, retain the expiry date.

==================================================
24. BRANCH DASHBOARD
==================================================

Owner should have a branch selector:

ALL BRANCHES
COLOMBO
KANDY
GALLE
PRODUCTION HOUSE
CENTRAL WAREHOUSE


For branches show:

Sales
Inventory Value
Low Stock
Out of Stock
Wastage
Transfers
Purchases
Production
Profitability

For Production House show:

Production Today
Production This Week
Raw Materials
Finished Goods
Production Cost
Production Variance
Pending Production
Expiring Batches
Transfers

For Central Warehouse show:

Inventory
Purchases
Incoming
Outgoing
Transfers
Low Stock
Stock Value

==================================================
25. CENTRAL OWNER DASHBOARD
==================================================

Owner should see:

Total Sales
Sales by Branch
Inventory Value
Inventory by Location
Production Output
Production Cost
Transfers
Purchases
Wastage
Food Cost
Gross Profit
Low Stock
Expiring Items

Use filters:

Date
Branch
Location
Category
Inventory Item

==================================================
26. LOCATION PERMISSIONS
==================================================

OWNER:

Access all restaurants' own locations.

RESTAURANT ADMIN:

Access all locations belonging to their restaurant.

BRANCH MANAGER:

Access assigned branch.

PRODUCTION MANAGER:

Access Production House.

WAREHOUSE MANAGER:

Access assigned warehouse.

WAREHOUSE STAFF:

Access assigned storage locations.

IMPORTANT:

Do not rely only on frontend hiding.

Enforce permissions server-side.

==================================================
27. MULTI-TENANT SECURITY
==================================================

Restaurant A:

Must NEVER see:

Restaurant B branches
Restaurant B warehouse
Restaurant B production house
Restaurant B inventory
Restaurant B transfers

Every database query must enforce restaurant ownership.

Do not trust restaurantId from client requests.

Resolve restaurant identity from authenticated session/server-side context.

==================================================
28. TRANSFER HISTORY
==================================================

Owner should be able to see:

Transfer ID
From
To
Items
Quantity
Requested by
Approved by
Dispatched by
Received by
Requested date
Approved date
Dispatch date
Received date
Status
Variance
Reason

Make each transfer clickable.

Show a complete timeline:

Requested
Approved
Dispatched
In Transit
Received
Completed

==================================================
29. PRODUCTION HISTORY
==================================================

Production House should have:

Production history.

Example:

Batch #PH-001

Chicken Patties
Planned: 500
Produced: 480
Variance: -20
Cost: Rs. 22,500
Cost/unit: Rs. 46.87

Show:

Raw materials consumed
Finished goods produced
Wastage
Variance
Users involved
Dates
Batch number

==================================================
30. INVENTORY FLOW VISUALIZATION
==================================================

Create a clear visual flow in the UI.

Example:

SUPPLIER
   ↓
CENTRAL WAREHOUSE
   ↓
PRODUCTION HOUSE
   ↓
FINISHED GOODS
   ↓
BRANCH
   ↓
KITCHEN
   ↓
CUSTOMER

Another flow:

SUPPLIER
   ↓
CENTRAL WAREHOUSE
   ↓
BRANCH
   ↓
KITCHEN
   ↓
CUSTOMER


The owner should be able to understand where stock came from and where it went.

==================================================
31. STOCK TRACEABILITY
==================================================

For any inventory item, provide:

"Where did this stock come from?"

Example:

Chicken Patty Batch PAT-001

Produced:
Production House

Quantity:
500

Transferred:
Colombo: 200
Kandy: 150
Galle: 100

Remaining:
50

The owner should be able to trace the complete movement.

==================================================
32. REVERSE TRACEABILITY
==================================================

Also support:

"Where did this stock go?"

Example:

Batch PAT-001:

Production House
→ Colombo
→ 150 sold
→ 5 wasted
→ 45 remaining

This is extremely important for inventory control.

==================================================
33. DATABASE DESIGN
==================================================

Before implementation, inspect the existing Prisma schema.

Do NOT create duplicate models if equivalent models already exist.

Prefer a generic:

Location

model with:

type:

BRANCH
PRODUCTION_HOUSE
CENTRAL_WAREHOUSE

Then:

StorageLocation

belongs to Location.

InventoryStock

belongs to:

Restaurant
Location
StorageLocation
InventoryItem

StockTransaction

references:

Restaurant
Location
StorageLocation
InventoryItem
Transaction Type
Reference

Transfer

belongs to Restaurant.

TransferItem

belongs to Transfer.

ProductionOrder

belongs to Restaurant and Production House location.

ProductionOrderItem

represents raw materials.

ProductionOutput

represents finished goods.

ProductionBatch

stores batch information.

Adapt these concepts to the EXISTING schema rather than blindly creating duplicates.

==================================================
34. DATABASE TRANSACTIONS
==================================================

All critical stock operations must use database transactions.

Examples:

Dispatch Transfer:

1. Validate source stock.
2. Create TRANSFER_OUT ledger.
3. Create IN_TRANSIT record.
4. Update transfer status.
5. Commit.

If anything fails:

Rollback.

Receive Transfer:

1. Validate transfer.
2. Record received quantity.
3. Create TRANSFER_IN ledger.
4. Resolve IN_TRANSIT quantity.
5. Record variance if applicable.
6. Update status.
7. Commit.

Production completion:

1. Validate raw materials.
2. Deduct raw materials.
3. Create production output.
4. Add finished goods.
5. Create batch.
6. Calculate production cost.
7. Complete production order.
8. Commit.

Never allow partial database state.

==================================================
35. IDEMPOTENCY
==================================================

Prevent duplicate stock transactions.

For example:

If a user clicks "Dispatch" twice:

Only ONE dispatch must happen.

If a user clicks "Receive" twice:

Only ONE receive transaction should happen.

Use database constraints/idempotency mechanisms.

==================================================
36. NEGATIVE INVENTORY
==================================================

Do not allow negative inventory by default.

If stock:

10

Transfer request:

15

Reject the dispatch.

Show:

"Insufficient stock."

Do not allow:

-5

unless the restaurant explicitly enables negative stock.

==================================================
37. UI REQUIREMENTS
==================================================

Add a new:

Locations / Branches

section.

Example:

Locations

[ All Locations ]

[ Colombo Branch ]
[ Kandy Branch ]
[ Galle Branch ]
[ Production House ]
[ Central Warehouse ]

Each location has its own dashboard.

Production House should have a dedicated dashboard.

Central Warehouse should have a dedicated dashboard.

==================================================
38. DO NOT BREAK EXISTING POS
==================================================

The existing:

QR ordering
Tables
Kitchen
Waiter
Billing
Payments
Menu
Restaurant admin

must continue working.

If existing Branch models already exist:

Reuse them.

If existing inventory models exist:

Extend them safely.

Do not duplicate data structures.

==================================================
39. MIGRATION SAFETY
==================================================

Before migration:

Inspect current Prisma schema.

Identify existing production data.

Create migration that is backwards compatible where possible.

Do NOT use:

prisma db push --force-reset

Do NOT reset the database.

Do NOT delete existing restaurants.

Do NOT delete existing orders.

Existing data must remain accessible after migration.

==================================================
40. TESTING
==================================================

Create an end-to-end test.

BUSINESS:

ABC Restaurant

LOCATIONS:

Central Warehouse
Production House
Colombo
Kandy
Galle

INVENTORY:

Chicken = 100kg
Spices = 10kg
Buns = 500
Chicken Patty = 0

PRODUCTION:

Production House produces:

100 Chicken Patties

Recipe:

Chicken = 20kg
Spices = 2kg

After production:

Chicken = 80kg
Spices = 8kg
Chicken Patties = 100

TRANSFER:

Production House → Colombo

40 Chicken Patties

After dispatch:

Production House available = 60
Colombo in transit = 40

After receiving:

Colombo available = 40
In transit = 0

TRANSFER:

Colombo → Kandy

10 Chicken Patties

After dispatch:

Colombo = 30
Kandy in transit = 10

Kandy receives:

8

Expected:

Kandy available = 8
Variance = -2

Require reason for 2 missing items.

==================================================
41. TEST RESTAURANT ISOLATION
==================================================

Create:

Restaurant A
Restaurant B

Restaurant A:

Colombo
Production House

Restaurant B:

Kandy
Production House

Ensure:

Restaurant A cannot access Restaurant B.

Test:

Branches
Locations
Inventory
Transfers
Production
Stock ledger

==================================================
42. FINAL VALIDATION
==================================================

After implementation:

Run:

- Prisma validation
- Prisma migration check
- TypeScript
- ESLint
- Production build
- Unit tests
- Integration tests

Fix all errors.

Do not simply report that something "should work".

Actually test the workflows.

At the end provide:

1. Database changes
2. New models
3. Modified models
4. API/server actions
5. UI pages
6. Permission changes
7. Stock ledger changes
8. Production workflow
9. Transfer workflow
10. Migration instructions
11. Test results
12. Any remaining risks

Do not proceed with unrelated features.

The objective of this phase is to make:

BRANCHES
WAREHOUSES
PRODUCTION HOUSE
INVENTORY
TRANSFERS
PRODUCTION
STOCK LEDGER

fully interconnected and production-ready.