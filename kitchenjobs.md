Redesign the current Kitchen Production / "Make Something" feature. The current flow (PRD → approval → jobs) is confusing.

First inspect the existing recipe, inventory ledger, costing, COGS, production models and permissions. Reuse existing authoritative logic. Do not create duplicate inventory, costing or COGS systems.

NEW SIMPLE FLOW:

Kitchen Production
→ New Production
→ Select Recipe
→ Enter Planned Quantity
→ Show required ingredients + available stock
→ Create Production Job
→ Kitchen makes it
→ Enter Actual Quantity Produced
→ Complete Production
→ Automatically update inventory

Example:

Recipe: Mayonnaise
Planned: 5 kg

Required:
Oil 3.5 kg
Eggs 1 kg
Vinegar 0.25 kg

When completed:
- Deduct actual ingredient quantities from inventory through the existing inventory ledger.
- Add the actual finished/prepared quantity to inventory.
- Record any production waste/loss explicitly.
- Use existing weighted-average costing.
- Preserve recipe version and costs used.
- Everything must happen atomically in one transaction.
- Completing twice must never deduct stock twice.

IMPORTANT ACCOUNTING LOGIC:

Kitchen production is an INVENTORY TRANSFORMATION, not immediate COGS.

Raw ingredients
→ Production
→ Prepared stock
→ Customer order consumes prepared stock
→ COGS

Do not create a second COGS calculation. Reuse the existing depletion/COGS system.

UI should be simple for kitchen staff:

Production Jobs
- Ready to Make
- In Progress
- Completed

Use clear labels:
"New Production"
"Planned Quantity"
"Actual Quantity Produced"
"Complete Production"
"Inventory Impact"

Remove unnecessary PRD/approval complexity unless an existing business rule genuinely requires approval.

Every production must be traceable:
Production → Recipe Version → Ingredients → Inventory Ledger → Prepared Stock → Future Order → COGS.

Respect tenant/branch isolation, permissions, audit logs, negative-stock rules and existing financial safety rules.

Do not directly mutate stock balances. Always use the existing inventory ledger.

Add tests for stock deduction, finished-stock creation, waste, costing, duplicate completion, rollback, recipe versioning, branch/tenant isolation and production → COGS traceability.

Before coding, audit the current implementation and then implement the cleanest solution without breaking existing data.