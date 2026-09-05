# Inventory

How stock is counted, valued and explained in TableFlow.

## Inventory accounting rules

**The ledger is the truth; the balance is its cache.** `postMovement`
(`src/features/inventory/ledger.ts`) is the only code that changes a stock
balance. It locks the item row (`FOR UPDATE`), converts the entered unit to
the item's base unit, refuses to go negative (restaurant-wide *and* per
branch — a branch cannot sell stock it does not hold while another site
does) unless `allowNegativeStock` is set, writes the movement with
`balanceAfter` and the cost in force, mirrors the change onto the branch
shelf (`InventoryStock`), and drains expiry-tracked lots FEFO **at the branch
the stock left from**.

Editing an item never edits its balance. Opening quantities are
`OPENING_BALANCE` movements; corrections are adjustments with a reason or an
approved stock count. The base unit **locks** the moment the first movement
exists — flipping KG to GRAM would re-denominate the whole history a
thousandfold. The honest path to a new unit is a new item and a transfer.

## Costing methodology — value-carrying WAC (§39)

The weighted average used to live only as a rounded integer per base unit;
for an item counted in grams, a real cost below one minor unit per gram
rounded to zero and whole deliveries were worth nothing on the books. The
tracked figure is now **`stockValue`** — the exact worth on hand, Decimal:

- receipts add at their own price,
- everything leaving subtracts at the running average (`value ÷ quantity`),
- reversals and transfers-in return value at the average — these rows used to
  be stamped zero, which is why the value ladder could never close,
- outbound movements never move the average — selling stock cannot change
  what the rest of it cost,
- when the balance empties or goes negative the value writes to zero:
  negative stock is a quantity problem, and negative value would poison the
  next receipt's average.

`costPerUnit` remains as the rounded cache of `stockValue ÷ quantity`, used
for display and fallbacks. It is **create-only** on the item form — after
creation the average belongs to the ledger, not the edit dialog. Every
movement row is stamped with the unit cost in force when it happened, so the
ledger answers in money as well as in quantity — the per-item history and
the cross-item ledger screen (`/dashboard/inventory/ledger`) both show it.

## Prepared items — kitchen production (redesignkitchenjob.md)

A prepared item (mayonnaise, curry paste, dough, prepped chicken) is an
ordinary `InventoryItem` with `isPrepared` set. It is made on
`/dashboard/production` → **Make Item**: name what you made, how much, in what
unit, and which stock items you used. One transaction (`produceItem`):

1. every ingredient leaves through `postMovement` as `PRODUCTION_CONSUMPTION`,
   refused if the branch does not hold enough — whatever `allowNegativeStock`
   says, production never plans against stock that is not there;
2. the **exact** value the ledger removed (`PostedMovement.valueMoved`, not
   quantity × the rounded `costPerUnit` cache) is summed;
3. the prepared item receives that value through a `PRODUCTION_OUTPUT`
   movement carrying `totalValue`, so raw value out equals prepared value in to
   the minor unit, and its average cost is value ÷ quantity;
4. optional waste rows are posted as `WASTAGE` (reason *Preparation*) in the
   same transaction, linked to the run by `WastageRecord.productionOrderId`, and
   **expensed** — never carried into the item's cost;
5. a `ProductionOrder` (status `COMPLETED`, `outputItemId`, `clientRequestId`)
   with `ProductionConsumption`/`ProductionOutput` snapshots is the record.

The form's request key makes the run idempotent: the same key twice is one run.
Production is an inventory **transformation** — nothing is expensed until a dish
that uses the prepared item is sold, when `reconcileOrderDepletion` consumes it
like any other ingredient and its value reaches COGS exactly once. Prepared items
appear in every ingredient picker automatically, and a prepared item can itself
be an ingredient of another. Any branch may produce. Pinned by
`scripts/prepared-items-test.ts`.

## COGS methodology

COGS comes from the ledger, not from a typed-in field:

1. When the kitchen accepts an order, `pinRecipeVersions` pins each line to
   the recipe version in force — later recipe edits cannot rewrite history —
   and `snapshotLineCosts` writes what the ingredients cost at that moment
   (recipe explosion at the weighted average, sub-recipes, yields and wastage
   percentages included). **Variant options with a recipe are added per
   selected option per line** — "extra chicken" costs and consumes chicken.
2. `reconcileOrderDepletion` is declarative and idempotent: it computes what
   the order *should* have consumed given its lines right now, compares with
   what it *has* (`OrderStockDepletion`), and posts only the difference.
   Every case — first acceptance, retries, quantity edits, cancellation —
   falls out of that single rule. Line-change callers (guest edits, voids,
   splits, merges) go through `reconcileIfDepleted`, which does nothing until
   the order has actually consumed something.
3. The profit report reads the per-line snapshots. **Purchases are not COGS**:
   the 80,000 that left the bank is not the 40,000 that left the kitchen,
   and `scripts/e2e-reconciliation-test.ts` holds that line end to end.

## Purchasing and receiving

Goods receiving is the PO→stock path: receipts post PURCHASE movements with
their real unit cost (blending the average by value), create lots for
batch-tracked items, and attribute spend to the branch that received it.
Quick purchases go through the same ledger call, number from the atomic
per-restaurant counter, and create lots too. Supplier ledgers track what is
owed; settling them is the accountant's one write permission.

## Counts, wastage, transfers

- **Stock counts** are maker-checker: the counter records, somebody else
  approves (owners/admins may self-approve — a one-person restaurant has no
  second signatory). Approval posts the *stored* variance — the number the
  approver actually saw — as adjustment movements, and returns the count's
  **money impact**, signed, into the audit trail.
- **Wastage** posts through the ledger with a reason, valued at the average.
- **Transfers** move stock between branches through paired movements;
  `assertSufficient` checks the *sending branch's* shelves.

## Reconciliation (§75, §116)

`getReconciliationReport` replays every item's ladder — opening + in − out =
closing — against the stored balances (per-branch shelf sums when a branch is
selected), flagging any drift. Beside every quantity is its **value ladder**:
each movement bucket priced at the cost stamped on its rows, with the exact
`stockValue` on hand shown against the derived closing value. The §115
integrity checker adds the standing invariants (balances vs movements,
shelves vs totals, consumption without an order, orphaned depletion rows) as
OK/WARNING/ERROR on the daily-close screen.

Pinned by `scripts/inventory-truth-test.ts`, `scripts/recipe-costing-test.ts`,
`scripts/reconciliation-test.ts` and `scripts/e2e-reconciliation-test.ts`.
