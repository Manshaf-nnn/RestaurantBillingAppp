# TableFlow — Advanced System Implementation Report

Against `workflow.md`. Written after the work, not before it, and it says what is
still wrong as plainly as what is fixed.

---

## Existing architecture

The engine was already sound and was not rebuilt. One inventory system, one stock
ledger, location deciding where stock sits — a branch, a central warehouse and a
production house are the same `Branch` record with a different `type`, so each
gets storage areas, `InventoryStock` rows and the transfer workflow without a
parallel system. `postMovement` is the only function permitted to change a
balance; `InventoryItem.quantity` is a cache written in the same transaction as
the row that justifies it.

What was wrong was not the architecture. It was that several paths went around it.

---

## The headline finding

Nineteen test suites and 636 assertions were green while four features were
completely broken in production and three more silently corrupted stock. The
reason is one sentence:

> **The tests called services. The buttons call actions. Nothing tested the gap.**

`qa-suite.ts` proved depletion worked by calling `reconcileOrderDepletion`
directly — but the order screen calls `cancelOrder`, which had its own hand-rolled
copy that behaved differently. `storage-stock-test.ts` proved shelf transfers
worked by calling `requestTransfer` directly — but the form calls
`requestTransferAction`, whose schema omitted the shelf fields entirely.

Every fix below is paired with a test at the layer that was missing.

---

## Changes made

### Adding a location never worked at all

```
Error: A "use server" file can only export async functions, found object.
```

`export const locationSchema = z.object({…})` sat above the actions that used it.
Next turns every export of a `'use server'` module into a callable server
reference and a Zod schema is not callable, so the module threw on the first call
into it and nothing was ever written. **Four features shipped this way** —
locations, recipes, wastage and loyalty settings. None of the schemas needed
exporting.

`tsc`, `next build` and all 636 tests passed throughout.

### Sales never took stock off the branch

`reconcileOrderDepletion` posted with no `branchId`, and `applyLocationDelta`
returns early without one. So `InventoryStock.available` **only ever went up** —
receipts and transfers added to it, sales took nothing away. Restaurant-wide
totals stayed right, which is why it went unseen, while every per-branch figure
drifted upward for ever. `assertSufficient` reads exactly that number, so
transfers were being approved against stock eaten weeks earlier.

### Three more paths went around the ledger

- **`cancelOrder`** incremented `quantity` directly, wrote a movement with no
  `balanceAfter`, skipped the location delta, and summed only `SALE`/`CONSUMPTION`
  — so an order that had ever been reduced returned **more than it took**. It left
  `orderStockDepletion` untouched, so a later reconcile returned everything again.
- **`voidOrderItem`** and guest edits marked lines cancelled and recalculated the
  money while the ingredients stayed consumed.
- **The inventory page** wrote `quantity` straight onto the row when editing an
  item, and `recordStockMovement` computed its own sign and clamped with
  `Math.max(0, …)` — so a withdrawal past zero wrote a full movement while the
  balance stopped, and the two could never agree again.

### COGS was a number typed into the menu

`OrderItem.costPrice` came from `Food.costPrice`, which defaults to 0, and the
recipe fallback meant to cover an empty one was unreachable — `costPrice ??
recipeCost` never fires on a non-nullable column. **Any owner who had not filled in
cost prices saw COGS 0 and a gross margin of 100%.** Cost is now snapshotted from
the pinned recipe at the weighted average in force, beside the version pin, and
`postMovement` stamps outbound movements with what the stock was worth.

### The two reports disagreed about revenue

Profit summed `lineTotal` (before discounts, before refunds); sales defined net as
gross − discounts − refunds. Same period, two answers. Order-level reductions are
now apportioned across lines.

### Security

- `canAccessBranch` existed with **zero call sites**. A user tied to Colombo could
  waste, adjust or dispatch Kandy stock by posting Kandy's id. `assertBranchAccess`
  now guards wastage, purchasing, production and transfers.
- `MANAGER` sat in `CROSS_LOCATION_ROLES`, so every branch manager saw every
  branch. Now decided per user: no branch assigned means group manager.
- Payment capture took no row lock, so concurrent settles wrote two `PAID` rows
  and the drawer double-counted.
- `/api/staff/lookup` was unauthenticated and turned a sequential staff code into
  that person's email — deleted.
- `/api/invite/accept` granted a full staff session with no rate limit and an
  open-redirect in its `target` parameter.

### Features that existed but could not be reached

- **Storage-to-storage transfers** — service supported them; the action schema
  omitted the shelf fields, and same-branch selection failed with a misleading
  error.
- **Pack units** — the converter handles "one box is 24 bottles" and refuses
  rather than guessing, but read two columns nothing ever wrote, so a PO raised in
  BOX threw at goods receipt.
- **Negative stock** was hardcoded permissive with `wentNegative` computed and
  read by nobody. Now `Restaurant.allowNegativeStock`, default off, with
  corrections always allowed through.
- **Reconciliation (§48)** did not exist as a report. Now at
  `/dashboard/reports/reconciliation`.

---

## Database changes

| Migration | What |
|---|---|
| `staff_sign_in_codes` | `users.signInCode` — the credential, separate from the identity code |
| `error_log` | `error_logs` — server errors keyed by the digest shown to the user |
| `allow_negative_stock` | `restaurants.allowNegativeStock` |

No destructive migrations. `prisma db push` was never used against production.

---

## Tests executed

`npm run verify` — **684 passing, 0 failing**, in three layers:

| Layer | What it catches |
|---|---|
| **static** (3) | Bug classes that type-check cleanly and fail at runtime |
| **service** (19 suites) | Business rules against a real database |
| **runtime** (2) | Pages and Server Actions over HTTP — the layer that was missing |

New: `order-lifecycle-test`, `cogs-test`, `negative-stock-test`,
`reconciliation-test`, `action-e2e-test`, `page-render-test`,
`no-bad-server-exports`, `no-function-props`, `no-raw-action-calls`.

Each new test was **run against the unfixed code first**. `order-lifecycle-test`
gives 7 failures before and 0 after; `cogs-test` gives 7 before and 0 after,
reporting `cogs 0`, `margin 100%` and `profit 10000 vs sales net 9000`.

---

## Final acceptance criteria

**Was 11 pass · 9 partial · 8 fail. Now 22 pass · 5 partial · 1 fail.**

| # | Criterion | Before | Now |
|---|---|---|---|
| 1–3 | Purchases increase stock · POs do not · sales consume recipes | pass | **pass** |
| 4 | Cancellations reverse consumption | **fail** | **pass** |
| 5–9 | Wastage · production · costing · warehouse · branch independence | pass | **pass** |
| 10 | Storage locations work | partial | **partial** — reachable for transfers; purchases still receive without a shelf |
| 11 | Transfer states | partial | **partial** — `RECEIVED`/`IN_TRANSIT` still collapsed into `COMPLETED` |
| 12–13 | Variance recorded · in-transit separated | pass | **pass** |
| 14 | Ledger records every movement | partial | **pass** |
| 15 | Ledger reconciles with inventory | partial | **pass** — including per branch, with a report |
| 16 | Recipe versions preserve history | pass | **partial** — menu recipes yes; prep recipes never version |
| 17 | Duplicate requests do not duplicate | **fail** | **partial** — payment fixed; order placement still has no idempotency key |
| 18 | Concurrent sales cannot corrupt | partial | **pass** |
| 19 | Negative prevented unless enabled | **fail** | **pass** |
| 20–21 | Atomic transactions · tenant isolation | pass | **pass** |
| 22 | Branch permissions server-side | **fail** | **pass** |
| 23 | Systems interconnected | pass | **pass** |
| 24 | COGS from actual consumption | **fail** | **pass** |
| 25 | Reports reconcile with transactional data | **fail** | **pass** |
| 26 | Audit preserves sensitive actions | partial | **partial** — coverage good, `before` captured at only 8 sites |
| 27 | History not silently modified | pass | **pass** |
| 28 | No critical issue remains | **fail** | **fail** — see below |

---

## Remaining issues

Honestly stated, in the order I would take them:

1. **Order placement has no idempotency key.** A double-submitted cart is two
   orders and two depletions. Rate limiting is not idempotency.
2. **Batches are only drawn down by wastage.** Sales and production never call
   `consumeBatches`, so `remainingQty`, FEFO and the expiry board drift for
   anything sold or made.
3. **Prep recipes never version.** The "has this been used" test counts
   `OrderItem.recipeId`, which is only ever set for menu recipes, so a prep recipe
   is edited in place for ever and history re-costs.
4. **Purchase returns have no UI.** The document and service are correct;
   `createPurchaseReturnAction` has no callers.
5. **Nothing assigns a shelf on receipt**, so §5 stays mostly decorative.
6. **The branch switcher is ignored by most pages** — 5 of ~30 read it.
7. **No item type** (raw material / finished good / packaging).
8. **Production yield loss is not costed** — inputs scale with actual output, so
   unit cost is identical whether a run makes 500 or 480, and the docstring claims
   the opposite.
9. **Audit rarely records `before`.**
10. **No supplier balances.**

---

## Final status

**NOT READY FOR PRODUCTION — but materially closer, and the gap is now known
rather than hidden.**

Nothing in the list above corrupts stock or misstates money, which was not true
at the start of this work: seven such defects were live and are fixed. What
remains is missing features and one real integrity gap (order idempotency).

The honest summary is that a system passing 684 tests, including runtime tests
through the layer users actually touch, is a different proposition from one
passing 636 that never exercised it. I would fix items 1 and 2 before selling
this to a second restaurant.

## Before deploying

Run the repair tool. The code fix stops the drift; it cannot undo it, and
existing branch balances still overstate what is on the shelf by everything ever
sold there.

```
npx tsx --tsconfig tsconfig.test.json scripts/repair-branch-stock.ts          # dry run
npx tsx --tsconfig tsconfig.test.json scripts/repair-branch-stock.ts --apply
```

And rotate the Neon password — it appeared in four screenshots during this work.
