REDESIGN KITCHEN PRODUCTION COMPLETELY

The current "Kitchen Jobs / Make Something" flow is confusing. Replace it with a simple Prepared Items production system.

GOAL
Restaurant staff can make prepared ingredients such as:
- Mayonnaise
- Sauce
- Curry paste
- Dough
- Chopped vegetables
- Prepared chicken

These prepared items must become real inventory items and later work correctly inside food recipes, COGS, stock valuation and reports.

NEW FLOW

Kitchen Production
Tabs:
1. Make Item
2. Prepared Items
3. Production History

MAKE ITEM

User manually enters:
- Prepared item name
- Quantity being produced
- Unit: g / kg / ml / L / pcs etc.

Then add ingredients.

Ingredient field MUST be a dropdown/search showing existing STOCK ITEMS only.

Each ingredient row:
- Stock item
- Quantity required
- Unit
- Current unit cost
- Ingredient cost

Example:

Mayonnaise — produce 1 kg

Eggs:
5 pcs × LKR 30 = LKR 150

Oil:
500 ml × LKR 0.80/ml = LKR 400

Other ingredients = LKR 100

Total production cost = LKR 650
Produced quantity = 1,000 g
Prepared-item cost = LKR 0.65/g

Use authoritative inventory costing/WAC values — never manually guess ingredient cost.

WHEN USER CLICKS "COMPLETE PRODUCTION"

In ONE atomic/idempotent transaction:

1. Validate enough ingredient stock.
2. Deduct each ingredient through existing inventory ledger.
3. Calculate exact total consumed inventory value.
4. Create/update the prepared inventory item.
5. Add produced quantity to stock through the inventory ledger.
6. Carry exact production value into the prepared item.
7. Save production record + ingredient snapshots + cost snapshots + user/branch/time.
8. Record any production waste separately.

Production is inventory transformation:
Raw Inventory Value ↓
Prepared Inventory Value ↑

It is NOT COGS yet.

Example:
5 eggs worth LKR150 + other ingredients LKR500
= LKR650 transferred into mayonnaise inventory.

PREPARED ITEMS TAB

Show:
- Item
- Available quantity
- Unit
- Average cost/unit
- Total stock value
- Last produced
- View production history

Prepared items must appear anywhere normal ingredients can be selected.

FOOD RECIPES

When creating a menu recipe, allow BOTH:
- Raw stock ingredients
- Prepared items

Example:

Chicken Burger recipe:
Chicken = LKR200
Bun = LKR80
Mayonnaise 20g × LKR0.65 = LKR13

Recipe cost = LKR293.

When the burger is sold, deduct mayonnaise stock exactly like another ingredient and include its value in:
- COGS
- Gross profit
- Recipe costing
- Inventory valuation
- Waste/variance
- Reports
- Reconciliation

IMPORTANT COSTING RULE

Never double-count COGS.

Making mayonnaise:
Egg/Oil → Mayonnaise inventory = inventory transformation.

Selling food using mayonnaise:
Mayonnaise inventory → COGS.

Use existing inventory ledger, WAC/value-carrying costing, recipe system and reconciliation logic. DO NOT create duplicate stock/costing engines.

UI

Remove confusing:
- Draft / Approved / Ready to Make stages
- PRD codes as primary UI
- unnecessary approval workflow for normal production

Keep production extremely simple:
Name → Quantity → Ingredients → Cost Preview → Complete Production.

Keep IDs/audit data internally.

Ensure tenant/branch isolation, Decimal-safe calculations, unit conversions, negative-stock controls, audit trail and full tests.