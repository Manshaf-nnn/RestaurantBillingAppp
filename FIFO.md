TABLEFLOW — MAKE FIFO THE SINGLE AUTHORITATIVE INVENTORY COSTING SYSTEM

FIRST inspect the existing Inventory, Stock Ledger, Purchases/GRN, Recipes, Production, POS, COGS, Wastage, Transfers, Stock Counts/Adjustments, Returns, Reports and Accounting logic.

Do NOT create a second inventory/costing system. Reuse the existing ledger and implement ONE central, transaction-safe FIFO engine used everywhere.

CORE RULE:

Every stock receipt creates a FIFO layer:

Item | Branch | Qty | Remaining Qty | Unit Cost | Value | Reference | Date/Lot

Example:
50 KG Cheese @ 100
20 KG Cheese @ 150

Stock = 70 KG, value = 8,000, next FIFO cost = 100.

Every stock OUT must consume the oldest layers first:

Consume 10 KG → 10 @ 100 → remaining 40 @ 100 + 20 @ 150.

Consume 35 KG → 35 @ 100 → remaining 5 @ 100 + 20 @ 150.

Consume 5 KG → remaining 20 @ 150 → next cost = 150.

If one transaction crosses layers, split the consumption internally and preserve every layer/cost used.

FIFO MUST apply to:

- Purchases/GRN
- Stock consumption
- Recipes/costing
- Kitchen Production
- POS sales / COGS
- Wastage
- Stock adjustments/counts
- Branch transfers
- Prepared/semi-finished items
- Returns/reversals
- Inventory valuation
- Profit/food-cost reports
- Accounting/reconciliation
- Exports

IMPORTANT:

Recipe cost = applicable FIFO cost.

Production:
Recipe → issue ingredients FIFO → record actual layers/cost → actual output/wastage → calculate:

Actual Production Cost ÷ Actual Output = Actual Cost/Unit

Finished/semi-finished production becomes a new FIFO inventory layer.

Production is inventory transformation, NOT immediate COGS.

POS/COGS must use the actual FIFO cost of the stock consumed and snapshot that historical cost so future purchases cannot change old COGS.

Transfers must preserve the original FIFO costs:
Source consumes FIFO layers → destination receives the same cost layers.

Wastage/adjustments must create proper ledger movements and preserve cost/audit history.

Inventory Value =
SUM(remaining FIFO layer quantity × layer cost).

“Current Unit Cost” means the cost of the NEXT FIFO stock to be consumed, NOT average cost/latest purchase price.

Do NOT overwrite old layers when a new purchase arrives.

Audit/remove conflicting WAC, average-cost, latest-price or duplicated costing logic. One central function/service must allocate FIFO for every outbound movement.

FIFO allocation MUST be:
- Database transaction safe
- Concurrency safe/locked
- Duplicate/idempotency safe
- Tenant isolated
- Branch isolated
- Fully auditable
- Impossible to consume the same layer twice
- No negative layer quantities

If negative stock is allowed by the existing policy, do not invent a fake FIFO cost; otherwise block insufficient stock.

Historical costs must NEVER change because of later purchases.

Existing historical data must NOT be destroyed. Safely migrate existing stock into appropriate opening FIFO layers if required. Use versioned migrations; never destructive production DB changes or `prisma db push`.

TEST THE EXACT FLOW:

50 KG @ 100
+ 20 KG @ 150
= 70 KG / 8,000 / next cost 100

Consume 10 → 40 @ 100 + 20 @ 150
Consume 35 → 5 @ 100 + 20 @ 150
Consume 5 → 20 @ 150
Consume 10 → 10 @ 150

Then test the same FIFO behavior through:
Purchase → Recipe → Production → POS/COGS → Wastage → Transfer → Adjustment → Inventory Valuation → Reports → Reversal/Return.

Every screen/report must reconcile with the same underlying ledger/layers.

FINAL RULE:

Do not only change the Stock screen.

Make FIFO the actual source of truth:

PURCHASE/GRN
→ FIFO LAYERS
→ INVENTORY LEDGER
→ PRODUCTION / RECIPE / POS / WASTAGE / TRANSFER
→ ACTUAL FIFO COST
→ COGS / INVENTORY VALUE / PROFIT / ACCOUNTING

AUDIT FIRST → REUSE EXISTING LOGIC → IMPLEMENT → MIGRATE SAFELY → TEST → RECONCILE.

Do not add unrelated features or duplicate business logic.