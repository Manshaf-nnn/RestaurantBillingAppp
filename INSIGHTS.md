# Insights — the owner's Command Center (smart.md)

`/dashboard/insights` and its three sub-pages (`/menu`, `/inventory`, `/waste`)
are an owner's view over numbers the engines already produce. The rule the
whole feature is built on: **compose and explain, never compute.** Every figure
on these screens is one of the report figures; where a page divides two of
them it does so for a sentence or a badge, never for a number that is then
summed or reported as money. Nothing under `src/features/insights/` writes.

## Which engine owns each number

| Screen figure | Owner | Notes |
|---|---|---|
| Sales, Net revenue, COGS, Gross profit, Food cost %, Cash collected, Waste, Outstanding | `getAccountingHub` (`accounting/hub.ts`) | Composed from `getSalesReport`, `getPaymentsReport`, `getProfitReport`, `getSupplierBalances`. "Cash collected" is the CASH row of collections by method — cash handed over before refunds, one of three cash definitions in the product and labelled as such. |
| Low stock | `getInventorySummary` (`inventory/alerts.ts`) | Live, not period-scoped; per location via `InventoryStock`, restaurant-wide otherwise. Same `levelFor` rule as the inventory report (the `/dashboard` tile's raw SQL still ignores `minStock` — a known, separate divergence). |
| "Why is this number?" | `buildExplanations` + `explainLowStock` (`accounting/explain.ts`) | Three new keys: `grossSales`, `cashCollected`, `waste`. `carryPeriod` appends `?preset=&from=&to=&branch=` so a source link lands on the same period. `explain-test` folds every one. |
| Needs review | `runIntegrityChecks` via `getFinancialReconciliation` | The pattern checks only (`ANOMALY_KEYS` in `insights/money-trace.ts`); the arithmetic checks stay on the reconciliation screen. |
| Health score | `scoreHealth` (`insights/health.ts`) | Pure. Inputs: hub (this and previous period), reconciliation status, inventory summary, `Restaurant.targetFoodCostBps`. |
| Where the money went | `MONEY_TRACE` (`insights/money-trace.ts`) | A constant tree of explanation keys; nothing to fold that `explain-test` does not already fold. |
| Menu & profit | `getProfitReport().byFood` + `costRecipesDetailed` | `byFood` is the same loop as `byItem`, keyed on `foodId`, untruncated, with `uncostedQuantity` and `menuPrice`. Recipe cost is today's from the resolver the kitchen depletes against — *not* `getMenuCostSummary` (serial N+1, `Food.price` only). |
| Stock outlook | `getUsageStats` (one SQL) + `getReorderSuggestions` + `computeUsage`/`recommendReorder` | Usage from the stock ledger; the threshold rule is purchasing's own and is never re-implemented. |
| Waste | `getWastageReport` | Gains `range` (a `DateRange`, restaurant time), `branchIds` (fail-closed) and `byCategory`. The Command Center's Waste KPI and this page are provably one number for any selection. |

## The fixed rules, and why

**Usage window — 28 days.** Four full weeks so weekday and weekend patterns
both appear. Clipped to the item's first movement, so an item that arrived on
Tuesday is averaged over its own life, not over days it did not exist. Usage
= `SALE + CONSUMPTION + PRODUCTION_CONSUMPTION`, net of `SALE_REVERSAL`.
Waste, transfers and hand adjustments are not usage: they say nothing about
how fast the kitchen goes through an ingredient.

**Days remaining** = stock on hand ÷ average daily usage, one decimal. `null`
when nothing was used; `0` when the shelf is empty.

**Recommended order** = max(usage × (lead time + 7 days) − on hand,
the purchasing module's own `suggestedQty`), rounded up to whole purchase
units when `unitsPerPurchaseUnit` is set. `minOrderQty` is not re-applied —
`getReorderSuggestions` already did, and applying it twice with the other
unit interpretation would make two screens disagree. (`suggestions.ts`
compares `minOrderQty`, documented as purchase units, against base units.
Left alone here; a follow-up.)

**Menu matrix — Kasavana & Smith.** Popular = at least 70 % of the average
dish's units; profitable = gross profit per unit at or above the menu's
weighted average. Dishes with unknown cost are `UNCOSTED` and left out of the
averages (otherwise a zero-cost dish is a Star on 100 % margin). Dishes on the
menu that did not sell are `NOT_SOLD`.

**Change flags.** Unit COGS moved ≥ 10 % vs the previous period; margin moved
≥ 5 points; today's recipe cost differs ≥ 10 % from what the sold plates cost.

**Health score.** Weights: sales trend 15, profit trend 15, food cost vs
target 20, waste share of COGS 15, stock levels 15, books 20. Gross margin
and food-cost % are one ratio seen from two sides, so profitability is scored
as the gross-profit *trend* and food cost as the *level* against the target
(default 35 % when none is set — the card says so). A signal without data is
excluded and the weights renormalise; the card says "based on N of 6
signals". Bands: ≥ 80 healthy, ≥ 60 needs attention, else at risk. The three
lowest weighted shortfalls are the issues.

**Anomaly checks** (all WARNING, 30-day windows, thresholds in the SQL, the
tenant's approval policy where one exists; a policy threshold of zero means
"not configured", never "flag everything"):

- `unusual-cancellations` — a bill cancelled with money still on it, or three
  or more cancellations this week when that is more than double the weekly
  run-rate of the previous three weeks.
- `void-concentration` — one person with ten or more voids/cancellations in a
  week and more than three times the average of everyone else who did any.
- `unusual-stock-adjustments` — a hand adjustment worth at least the approval
  threshold, or moving a quarter or more of what was on the shelf.
- `unusual-wastage` — an item wasted three or more times where a fifth or more
  of what left stock went in the bin, or this week's waste value is more than
  double the weekly average of the three weeks before.
- `unusual-cash-variance` — a counted difference at or above the review
  threshold, or the same cashier short three or more times. (Not
  `cash-variance`: that key is already a money identity.)
- `after-hours-activity` — a payment more than an hour outside the location's
  opening hours, in the restaurant's own time. Only for locations whose hours
  were actually entered; with none set the check reports OK and says why,
  because judging a place against hours it never set would flag every
  late-night restaurant on earth.

The nightly `integrity-check` job captures any non-OK report as a WARNING in
the error centre, so these checks add WARNINGs there. That is the intended
"flag for review" behaviour. Nothing writes to a financial record.

## Known divergences the screens show rather than hide

- **Partial refunds (profit vs sales).** `getSalesReport` deducts the refunds
  ledger; `getProfitReport` deducts only payments whose status flipped to
  `REFUNDED`. When they differ the money trace prints both figures and the
  gap. Making `profit.ts` deduct the refunds ledger is the right fix, but it
  moves gross-profit figures on existing screens and needs its own evidence
  and pin updates — a separate change.
- **List price vs sold price.** `Food.price` ignores branch prices, happy
  hour, discount price and option deltas; `revenue ÷ quantity` includes them.
  The menu page shows both columns, labelled.
- **Branch collapse.** Inventory-side engines take one location; a user
  confined to several sees restaurant-wide stock figures beside multi-branch
  money figures. The cards say "at the selected location" / "across all
  locations".

## Permissions and routes

`/dashboard/insights*` is a route of the `accounting` feature and guards
`ACCOUNTING_VIEW` — owners, admins, managers and accountants. No new
permission, so no role migration. An accountant may hit `/forbidden` on some
drill links (profit report, inventory); that is the registry doing its job.

## Tests

`scripts/insights-test.ts` (service tier): the pure maths with fixture
numbers (usage, reorder, matrix, change flags, health, period carrying),
`byFood` summing to the profit totals, waste by category and the KPI/page
identity, the new explanations, each anomaly check silent on a clean tenant
and firing on a seeded case, and a read-only proof (row counts unchanged by
every insights read). `explain-test` folds the new explanations
automatically. `page-render-test` opens the four pages.
