UPGRADE TABLEFLOW INTO A SMART RESTAURANT MANAGEMENT SYSTEM

First audit the existing implementation. Do NOT rebuild working features or create duplicate business logic. Reuse the existing billing, inventory, recipe, COGS, accounting, reconciliation and reporting engines.

IMPLEMENT:

1. OWNER COMMAND CENTER
Show:
Sales, Net Revenue, COGS, Gross Profit, Food Cost %, Cash, Waste, Outstanding, Low Stock.
Every KPI must have a simple "Why is this number?" drill-down to its source records.

2. PROFIT INTELLIGENCE
For every menu item:
Selling Price → Recipe Cost → COGS → Gross Profit → Margin → Food Cost %.
Highlight major cost/profit changes.

3. MONEY TRACE
Allow owners to drill:
Profit → Revenue/COGS → Orders/Inventory → Payments/Purchases/Recipes.
Every financial number must be traceable.

4. SMART INVENTORY
Show:
Current Stock, Average Usage, Days Remaining and Recommended Reorder Quantity.
Example: "Chicken: 0.6 days remaining — recommend ordering 50kg."

5. WASTE INTELLIGENCE
Show waste by item, category and reason, including monetary impact and biggest sources of loss.

6. MENU INTELLIGENCE
Automatically classify:
⭐ Stars — high sales + high profit
💰 Workhorses — high sales + low profit
💎 Hidden Gems — low sales + high profit
⚠️ Problem Items — low sales + low profit

7. ANOMALY ALERTS
Detect unusual:
Discounts, refunds, cancellations, stock adjustments, wastage, cash variance and suspicious activity.
Flag for review only. Never automatically change financial records.

8. RESTAURANT HEALTH SCORE
Create a simple 0–100 score based on:
Sales, profitability, food cost, waste, inventory and reconciliation.
Show the top 3 issues requiring attention.

UI:
Make this extremely simple and owner-friendly.
Use clear cards, alerts, explanations and drill-downs.
Avoid unnecessary dashboards, settings, buttons and filters.

CRITICAL:
- Reuse existing authoritative calculations.
- No duplicate billing/COGS/inventory logic.
- Use Decimal/minor units.
- Preserve tenant and branch isolation.
- Respect RBAC.
- Keep all financial actions auditable.
- Do not invent financial numbers.
- Do not modify existing accounting rules without evidence.
- Do not add AI features.

First inspect what already exists, then implement ONLY missing functionality.
Run all existing tests and add tests for every new calculation and business rule.