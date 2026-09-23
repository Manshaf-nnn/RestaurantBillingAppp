TABLEFLOW — KITCHEN PRODUCTION REBUILD
STRICT IMPLEMENTATION PROMPT

IMPORTANT:
This Kitchen Production module has already been rebuilt multiple times and is still not correct.

I need you to rebuild/fix it based EXACTLY on the requirements below.

DO NOT add extra features.
DO NOT invent additional workflows.
DO NOT change the business logic.
DO NOT simplify by removing required steps.
DO NOT create a second inventory/costing system.

FIRST inspect the existing:
- Production module
- Recipe module
- Inventory/Stock
- Stock ledger
- Item/Ingredient system
- Costing system
- Units
- Batch/Lot system if available

Reuse the existing authoritative inventory and database architecture wherever possible.

The goal is to make the system behave like ACTUAL KITCHEN PRODUCTION.

==================================================
CORE FLOW
==================================================

The complete flow must be:

1. SET RECIPE
        ↓
2. CHECK AVAILABLE STOCK
        ↓
3. CREATE PRODUCTION ORDER
        ↓
4. ISSUE/CONSUME INGREDIENTS
        ↓
5. COMPLETE PRODUCTION
        ↓
6. FINISHED ITEM ADDED TO STOCK

Do not change this flow.

==================================================
1. RECIPE SETUP
==================================================

Recipe Master must allow creating a recipe for a particular item/food.

Recipe must contain:

- Recipe name
- Category
- Expected yield
- Yield unit
- Instructions/notes
- Ingredients

Each ingredient must contain:

- Ingredient/item
- Required quantity
- Unit
- Current FIFO cost
- Total ingredient cost

The system must calculate:

Total Recipe Cost
Standard Cost per Unit

Recipe cost must use the required FIFO inventory costing logic.

Example:

Chicken Breast
12 kg × FIFO cost

Cooking Oil
0.5 kg × FIFO cost

Spices
0.3 kg × FIFO cost

Salt
0.1 kg × FIFO cost

Total Recipe Cost = sum of actual FIFO ingredient costs.

Do NOT create a separate fake costing engine.

==================================================
2. CHECK AVAILABLE STOCK
==================================================

Before production, the user must be able to check current ingredient stock.

Show:

- Item
- Available quantity
- Unit
- FIFO cost

The production workflow must use the actual available inventory.

Do not allow the system to pretend stock exists when it does not.

Use the existing inventory rules for stock validation.

==================================================
3. CREATE PRODUCTION ORDER
==================================================

User selects a recipe.

Enter:

- Recipe
- Planned production quantity
- Unit
- Production type
- Required date
- Remarks

Production types should support the client's required concept of kitchen production and should allow semi-finished/finished production where the existing system supports it.

Create the Production Order.

Example:

Production Order #PO-0001

Recipe:
Chicken Shawarma Filling

Planned Quantity:
10 KG

Status:
In Progress

IMPORTANT:

Creating a Production Order alone must NOT incorrectly deduct stock.

Stock deduction happens when ingredients are actually issued/consumed.

==================================================
4. START PRODUCTION / ISSUE INGREDIENTS
==================================================

When the kitchen actually starts production, the system must issue/consume the ingredients.

Show:

- Ingredient
- Required quantity
- Issue quantity
- Unit
- FIFO cost
- Total cost

Example:

Chicken Breast
Required: 12 KG
Issue: 12 KG
FIFO Cost: 12.50
Total: 150.00

Cooking Oil
Required: 0.50 KG
Issue: 0.50 KG
FIFO Cost: 8.00
Total: 4.00

etc.

There must be an:

"ISSUE ALL (FIFO)"

action.

When ingredients are issued:

- Deduct the ingredients from stock
- Use FIFO stock layers/lots
- Record exactly which stock layers/lots were consumed
- Record the actual cost consumed
- Preserve traceability
- Create the proper inventory ledger movements

Do not simply reduce a stock balance without a ledger entry.

==================================================
5. FIFO COSTING
==================================================

FIFO is REQUIRED for this production workflow.

When ingredients are issued, consume the oldest available stock first.

Example:

Chicken stock:

5 KG @ 12.00
20 KG @ 12.80

Production requires 12 KG.

System must consume:

5 KG @ 12.00
7 KG @ 12.80

The production batch must preserve the actual ingredient cost used.

Do NOT use an arbitrary average cost.

Do NOT use the recipe's old displayed cost when actual production occurs.

Actual production cost must come from the inventory actually consumed.

==================================================
6. COMPLETE PRODUCTION
==================================================

After cooking/production, the user must complete the production order.

The system must ask for:

- Actual produced quantity
- Unit
- Wastage quantity if applicable
- Remarks

Example:

Planned:
10.00 KG

Actual Produced:
9.60 KG

Wastage:
0.40 KG

The user must be able to record actual production output.

Do not automatically assume the planned quantity was produced.

==================================================
7. ACTUAL PRODUCTION COST
==================================================

When production is completed:

Calculate:

Actual Ingredient Cost
÷
Actual Produced Quantity
=
Actual Cost Per Unit

Example:

Total Ingredient FIFO Cost:
160.10

Actual Output:
9.60 KG

Actual Cost/KG:
16.68

This is the actual cost of the production batch.

Do NOT calculate the finished item's cost using the planned quantity if the actual output is different.

==================================================
8. FINISHED / SEMI-FINISHED ITEM STOCK
==================================================

After production is completed:

The produced item must automatically be added to inventory.

Example:

Chicken Shawarma Filling

Quantity:
9.60 KG

Actual Cost:
16.68/KG

This must become an actual inventory stock entry.

The produced item can be:

- Semi-finished item
OR
- Finished item

depending on the recipe/item configuration.

The produced item must be available for:

- Future recipes
- Kitchen usage
- Sales/other existing inventory workflows where applicable

==================================================
9. PRODUCTION BATCH TRACEABILITY
==================================================

Every completed production must have a unique production reference/batch.

The system must be able to trace:

Production Batch
→ Recipe
→ Ingredients consumed
→ FIFO stock lots/layers consumed
→ Actual ingredient cost
→ Actual output
→ Wastage
→ Actual cost/unit
→ Finished/semi-finished stock entry

Do not lose this history.

==================================================
10. ATOMIC TRANSACTION
==================================================

Production completion must be safe and atomic.

The final operation must ensure:

Ingredient consumption
+
Production cost calculation
+
Finished/semi-finished stock addition
+
Production completion
+
Audit/reference

either all succeed or all fail.

Never leave a situation where:

ingredients were deducted
but finished stock was not created.

Never duplicate production if the user clicks the button twice.

Use transaction/idempotency protection.

==================================================
11. SIMPLE UI
==================================================

Use a simple structure:

Production

TAB 1:
Make an Item / Production

TAB 2:
Prepared / Produced Items

TAB 3:
Production History

Do not add unnecessary screens.

The UI does NOT need to copy the provided reference image visually.

Only the BUSINESS CONTENT and FLOW must match these requirements.

Keep the existing TableFlow design system.

==================================================
12. PREPARED / PRODUCED ITEMS
==================================================

After production, the produced item should appear in Prepared/Produced Items.

Clicking the item should show:

- Item name
- Current stock
- Unit
- Current cost
- Production history
- Ingredients used
- Quantity produced
- Production cost
- Batch/reference

If the same item is produced again:

DO NOT create a duplicate item.

Allow another production batch for the SAME item.

Each production run must have its own history/batch/cost.

==================================================
13. PRODUCTION HISTORY
==================================================

Production history must show the complete production story.

For each production:

- Production reference
- Item
- Recipe
- Date/time
- Planned quantity
- Actual quantity
- Wastage
- Ingredients consumed
- FIFO costs
- Total production cost
- Actual cost/unit
- User
- Branch/location
- Status
- Batch/reference

The history must represent what actually happened.

==================================================
14. INVENTORY INTEGRATION
==================================================

Production MUST use the existing authoritative inventory ledger.

Do not directly manipulate stock balances.

Ingredient consumption:
→ Inventory Ledger

Finished production:
→ Inventory Ledger

All stock movements must remain auditable.

Do not create a second stock balance system.

==================================================
15. IMPORTANT ACCOUNTING/COSTING RULE
==================================================

Production itself is an INVENTORY TRANSFORMATION.

It is NOT immediate COGS.

Example:

Raw ingredients
↓
Production
↓
Semi-finished/finished inventory

Later:

Finished/semi-finished item
↓
Used in another recipe / sold
↓
Existing inventory + COGS system handles the appropriate cost flow.

Do not create a separate COGS engine inside Production.

==================================================
16. WHAT NOT TO ADD
==================================================

Do NOT add:

- Extra approval workflows
- Extra dashboards
- AI
- New payment system
- New accounting system
- New inventory system
- New costing engine
- Unrequested forecasting
- Unrequested scheduling
- Unrequested supplier features
- Unrequested purchasing features
- Unrequested reports
- Complex production planning

Only implement what is required above and what is necessary for the existing system to work correctly.

==================================================
17. CRITICAL IMPLEMENTATION RULE
==================================================

Before coding:

AUDIT → UNDERSTAND → PLAN → IMPLEMENT → TEST.

Do not start by creating new tables/components blindly.

Find the existing inventory ledger, stock item model, units, costing, recipe and production implementation.

Reuse existing logic.

If existing logic conflicts with this production requirement, identify the conflict and implement the minimum necessary change.

Do not silently replace existing financial/inventory architecture.

==================================================
18. TEST THE COMPLETE REAL FLOW
==================================================

Test this exact scenario:

Recipe:
Chicken Shawarma Filling

Expected output:
10 KG

Ingredients:
Chicken Breast
Cooking Oil
Spices
Salt

Stock contains multiple FIFO lots.

Create Production Order.

Verify:
NO stock deduction yet.

Start production.

Issue ingredients using FIFO.

Verify:
Correct stock lots deducted.

Verify:
Correct actual FIFO cost recorded.

Complete production.

Enter:
Actual output = 9.60 KG
Wastage = 0.40 KG

Verify:

Actual Ingredient Cost
÷
9.60 KG
=
Actual Cost/KG

Verify 9.60 KG is added to finished/semi-finished stock.

Verify the produced item has the correct actual cost.

Verify the raw ingredients decreased correctly.

Verify the production history contains the complete trace.

Refresh the application.

Verify all data remains correct.

Try double-clicking completion.

Verify production is not duplicated.

==================================================
FINAL REQUIREMENT
==================================================

THIS IS A REBUILD.

Do not make another partial implementation.

Do not add your own interpretation of the business workflow.

Do not miss any of the required steps.

The final system must behave like the actual kitchen process:

RECIPE
→ CHECK STOCK
→ PRODUCTION ORDER
→ ISSUE INGREDIENTS USING FIFO
→ ACTUAL COOKING
→ ENTER ACTUAL OUTPUT/WASTAGE
→ CALCULATE ACTUAL COST
→ ADD FINISHED/SEMI-FINISHED ITEM TO STOCK
→ PRESERVE COMPLETE BATCH TRACEABILITY

After implementation, run all relevant tests and report exactly what was changed and what was verified.