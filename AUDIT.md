# RestaurantOS — Phase 0 Audit (against finalprompt.md)

> Produced 2026-09-02 by a six-domain parallel audit (billing/payments, inventory/costing,
> orders/KDS, reports/reconciliation, security/tenancy/DB, UX/testing/docs) plus synthesis.
> This document is the baseline the 7-slice remediation works down; scores are
> re-earned, never assumed. Per-domain evidence lives in the workflow transcripts.


Read against finalprompt.md §118 (phase order), §120 (scorecard rules), §121 (definition of done), §122–125 (accountant tests), §126 (required return shape). Six domain audits reconciled; no code modified.

---

## 1. Scores (§126, /5 — no unearned 5s; where auditors disagreed, lower wins unless the higher score's evidence covered the other's finding)

| # | Area | Score | Decisive evidence |
|---|------|:-----:|-------------------|
| 1 | Architecture | **2** | Write paths have real single engines (computeTotals, postMovement, reconcileOrderDepletion) but the read side ships three simultaneous revenue definitions (analytics/queries.ts:115,636 vs sales.ts:161 vs profit.ts:170), and five spec-mandated entities do not exist at all: TableSession, Refund, PrintJob, DailyClose, AccountingPeriod. |
| 2 | Inventory | **3** | The ledger is genuinely single-writer, FOR UPDATE-locked, idempotent, reversal-not-deletion (ledger.ts:148-305, depletion.ts:45-174) — but variants/add-ons never consume stock (scored 0 in-domain), WAC re-bases on negative stock and rounds Int-per-base-unit, and branch balances go negative unguarded. |
| 3 | Accounting/reporting | **1** | No daily close, no accountant daily report, no accounting periods, no cross-domain reconciliation, no consistency checks, no integrity checker (specs 50/51/59/75/76/115/116 all at 0–1); the accountant's landing page and its exports use formulas the sales/profit modules contradict; the inventory quantity ladder is the only correct reconciliation. |
| 4 | Billing | **3** | computeTotals is one deterministic integer engine used by all four server write paths with full server authority over money (5/5 on that sub-area) — but applyManualDiscount corrupts totals two independent ways, and an Invoice exists only after full settlement, so every unpaid bill has no invoice to be outstanding against. |
| 5 | Payment | **2** | capturePayment's FOR UPDATE + overpayment ceiling + drawer attribution are solid; refunds are a check-then-act race that mutates the original row with no Refund record and no UI caller, partial/split payment is unreachable from the till, and BANK_TRANSFER cannot be recorded (spec 9 unimplementable). |
| 6 | Database | **2** | 37 @@unique constraints including order/invoice numbers and depletion idempotency are right; but `grep CHECK prisma/migrations` returns nothing — zero CHECK constraints in 60+ migrations — no SKU unique, and the spec-named models (Refund, TableSession, PrintJob, DailyClose, AccountingPeriod) plus StockMovement's item+branch+date and location indexes are absent. |
| 7 | Security | **3** | Guard architecture is uniform (only 9 unguarded actions, all deliberately public; no unsafe raw SQL; four-way escalation vetting) — but ORDER_CREATE applies unlimited discounts bypassing DISCOUNT_APPLY, Notification.audience is never enforced, and rate limits are per-process no-ops on the serverless target. |
| 8 | Multi-tenancy | **3** | restaurantId is derived from session everywhere and the restaurant boundary scan came back clean — but /api/health/errors returns every tenant's error messages and stack traces to any owner, and all five cashier bill actions (hold/resume/split/merge/void) have zero branch checks. |
| 9 | UI/UX | **2** | Loading skeletons, error boundaries and the 935-line help page are real; but not one summary number in the product is clickable (StatCard has no href), refunds and partial payments have no UI at all, the printed receipt's lines cannot produce its own total, and the waiter board's primary button throws on its common case. |
| 10 | Testing | **3** | 70 scripts in an honest three-tier harness including deliberately-broken-books reconciliation tests — but the runtime tier skips to a green exit by default, nothing tests computeTotals directly, tax-inclusive mode, cross-report agreement, or the purchase→GRN→sale→COGS→report chain: the exact seams where all four reporting CRITICALs live. |

**Adjudications (where auditors contradicted):**
- **Multi-tenancy 4 → 3.** The security auditor's 4 was scoped to restaurant-boundary server actions; the UX auditor's cross-tenant ErrorLog read is a genuine tenant-isolation break and the cashier branch holes sit inside the branch-scoping promise the product sells. Lower wins.
- **Consumption timing: orders auditor (3) over inventory auditor (4).** Two of four reconcile call sites (guest edit, line void) fire unguarded on never-accepted orders — "one authoritative event" does not hold.
- **applyManualDiscount fix path:** reuse `recalculateOrderTotals` (billing auditor's second option) rather than patching the include filter — one re-derivation path per spec 103 — plus the coupon/manual column split, or the coupon-erasure defect persists.
- **Invoice layer:** option (b) — finalize an Invoice at bill presentation — is right, not renaming Invoice to Receipt. Specs 5–11/46/65/111 describe a document that exists before settlement; outstanding needs something to be outstanding against.
- **Guest-identity blame:** the phone='' collapse pre-dates the uncommitted working-tree change (staff path); the change extends it to the whole public QR channel. Fix both paths; run the data cleanup regardless of whether the working-tree change ships. **Do not commit the working tree as-is.**

---

## 2. CRITICAL issues (deduped; money/stock silently wrong or a spec-mandated control absent with real damage)

**C1. Guest "remove item" drops the line from the bill but leaves it on the order — free food, still cooked, still consumed.**
Risk: order-tracker.tsx:148 filters quantity>0 lines out of the payload; the server (orders/actions.ts:342-356) only touches submitted lines but recomputes totals from the `keep` subset — the zeroed line stays QUEUED on the KDS, keeps depleting stock, and disappears from grandTotal. Any guest at any table can eat unbilled; consumption-without-revenue reads as theft in reconciliation.
Fix: make the payload authoritative for the whole order — server loads every non-cancelled line, treats absent lines as quantity 0, and drives both persisted rows and totals from one resolved map; client stops filtering. Regression test: sum(lineTotal where status≠CANCELLED) === order.subtotal after every guest edit.
Files: `src/features/orders/components/order-tracker.tsx`, `src/features/orders/actions.ts`

**C2. Every anonymous guest collapses into one shared Customer row whose pooled loyalty points any guest can redeem.**
Risk (3 auditors): blank phone defaults to `''` (actions.ts:291), Customer upserts on `@@unique([restaurantId, phone])` (service.ts:514), settleLoyalty accrues onto the shared row, and `redeemPoints` is in the public guest schema — any diner can post it and take up to 50% off their bill from the pool. Blocking one walk-in blocks all; CRM totals are meaningless.
Fix: never attach a Customer when phone is blank (`customerId: null`, snapshot columns only); reject guest `redeemPoints` without verified identity; data cleanup: null out customerId pointing at phone='' rows, zero the pooled points; partial unique index refusing `''`.
Files: `src/features/orders/service.ts`, `src/features/orders/actions.ts`, `src/features/orders/schema.ts`, `src/features/orders/components/cart-checkout.tsx`, `prisma/schema.prisma`

**C3. Any holder of ORDER_CREATE applies unlimited manual discounts, bypassing DISCOUNT_APPLY and the approval policy.**
Risk: createStaffOrder passes `manualDiscount` (uncapped) straight to placement (orders/actions.ts:806,844); WAITER holds ORDER_CREATE but not DISCOUNT_APPLY; computeTotals clamps at 100% — a free meal, auditable only as a small ORDER_PLACED total. `approvals.discountAbove` has zero callers in any discount path.
Fix: require DISCOUNT_APPLY when manualDiscount>0 (or strip the field from creation); wire `needsApproval`/`requestApproval` for amounts over policy; emit ORDER_DISCOUNT audit with before/after on this path.
Files: `src/features/orders/actions.ts`, `src/features/orders/schema.ts`, `src/features/approvals/service.ts`

**C4. Two cancellation paths leak money and stock: updateOrderStatus can cancel a PAID order, and cancelOrder lets a PARTIAL-paid order die with the money kept.**
Risk: the CANCELLED branch in updateOrderStatus (service.ts:1028) releases stock but skips the paid guard, loyalty/coupon/table/item reversals — a paid, invoiced order can be cancelled with phantom stock returned and Payment/Invoice orphaned (spec 97's forbidden half-success). cancelOrder itself refuses only `PAID`, so a PARTIAL bill cancels with paidTotal>0 retained, invisible to revenue, visible to the drawer.
Fix: delete the CANCELLED branch — updateOrderStatus delegates to cancelOrder; remove CANCELLED from updateOrderStatusSchema (and from updateItemStatusSchema, which reverses nothing — delegate to voidOrderItem); change cancelOrder's guard to `paidTotal > 0 → refund first`; point kitchen reject at cancelOrder with a reason.
Files: `src/features/orders/service.ts`, `src/features/orders/schema.ts`, `src/features/orders/actions.ts`, `src/features/kitchen/components/kitchen-board.tsx`

**C5. applyManualDiscount re-bills voided lines AND erases granted coupon discounts.**
Risk: it recomputes from all items with no status filter (actions.ts:901) — voided lines' totals return to the bill after their stock was already returned; and it writes `discountTotal` from manualDiscount alone (actions.ts:908), wiping the coupon's contribution while CouponRedemption and usedCount stand. Guest overcharged twice over, silently, on an audited-looking path.
Fix: replace the bespoke recompute with `recalculateOrderTotals` (already filters CANCELLED, single derivation path); split `Order.couponDiscount`/`manualDiscount` columns (discountTotal derived) so the two never overwrite each other; regression: void → discount → assert subtotal equals surviving lines.
Files: `src/features/orders/actions.ts`, `src/features/orders/pricing.ts`, `prisma/schema.prisma`

**C6. refundPayment has a check-then-act race — a double-submitted refund pays out twice.**
Risk: payment read outside the transaction, unconditional status update, stale paidTotal delta, drawer movement per call (payments/service.ts:456-489). Two concurrent calls: cash out twice, drawer short, split-bill orders mis-stated — the exact treatment capturePayment already has and this path never got.
Fix: load inside the transaction under FOR UPDATE (guardLocks pattern), or conditional `updateMany({where:{id, status:'PAID'}})` aborting on count 0; recompute paidTotal by summing PAID payments rather than subtracting a delta.
Files: `src/features/payments/service.ts`

**C7. Variants and add-ons are priced but never consume stock.**
Risk: VariantOption has no inventory/recipe link; resolveOrderConsumption reads only foodId/quantity/recipeId — "Full portion" deducts the Normal recipe, "Extra chicken" deducts nothing. The largest silent stock/COGS/margin overstatement in the system, invisible until a count writes it off as shrinkage (spec 29).
Fix: add `VariantOption.recipeId` (delta recipe) or a VariantOptionIngredient join (additive migration, existing options = no effect); snapshot resolved option ingredients into OrderItem.options at placement; fold option totals into the same depletion map (idempotency then holds unchanged); include option cost in snapshotLineCosts; add stock assertions to variant tests.
Files: `prisma/schema.prisma`, `src/features/inventory/recipe-resolver.ts`, `src/features/orders/service.ts`, `src/features/inventory/depletion.ts`, `scripts/variant-order-test.ts`

**C8. An item's base unit is editable after movements exist — silently re-denominating the entire ledger.**
Risk: KG→GRAM turns 50kg into 50g, re-prices costPerUnit 1000×, invalidates every historical movement, batch, threshold and recipe line; no conversion, no audit. The form comment names the risk but guards only the dropdown contents.
Fix: refuse the change when any movement/batch/stock exists (`ITEM_UNIT_LOCKED` 409); disable the select on edit with the same explanation Quantity already has.
Files: `src/features/inventory/actions.ts`, `src/features/inventory/components/inventory-manager.tsx`

**C9. Three contradictory revenue definitions ship at once; the accountant's landing page and every export use the two wrong ones.**
Risk: "Revenue"/"Gross revenue" = SUM(grandTotal) — tax, service charge and tips counted as income (spec 110/92 violated on the dashboard, reports screen, CSV and Excel); "Net sales"/"Gross profit" on /dashboard/reports = pre-discount subtotal (overstating profit by the whole discount pot); loyalty accrues points on grandTotal, i.e. on tax and tips. Spec 102's identity fails four ways for the same day.
Fix: one revenue vocabulary in the reports module (grossSales = Σsubtotal; netSales = gross − discounts − refunds; billedTotal for grandTotal); delete getReportSummary's computation and point /dashboard/reports + the export route at getSalesReport/getProfitReport; dashboard tile becomes Net sales with tax/service/tips as their own tiles; base pointsEarned on net revenue.
Files: `src/features/analytics/queries.ts`, `src/app/dashboard/page.tsx`, `src/features/reports/components/reports-view.tsx`, `src/features/reports/export.ts`, `src/app/api/reports/export/route.ts`, `src/features/orders/service.ts`

**C10. Report periods and branch scope are silently wrong: pages never pass the restaurant timezone, and refunds are not branch-filtered.**
Risk: five report pages call resolveRange with no timeZone — on Netlify (UTC) an Asia/Colombo "Today" runs 05:30–05:29 and disagrees with the timezone-aware dashboard for the same button; and the sales-report refund aggregate has no branch predicate, so branch-filtered net sales subtracts every other location's refunds and branches never sum to the group.
Fix: `timeZone: restaurant.timezone` on all five call sites + a lint script asserting it; add the same `order.branchId in branchIds` predicate the sibling queries already use to the refund aggregate. Five one-liners.
Files: `src/app/dashboard/reports/{sales,profit,purchasing,inventory,reconciliation}/page.tsx`, `src/features/reports/sales.ts`

**C11. /api/health/errors returns every tenant's error messages and stack traces to any restaurant owner.**
Risk: ErrorLog rows are written without restaurantId and queried with no tenant predicate behind SETTINGS_MANAGE (which every owner holds) — raw Prisma messages naming other tenants' records, routes and stacks, cross-tenant, cached in the in-memory list too.
Fix: populate `restaurantId` at capture; scope the query (and `recentErrors()`) to the caller's tenant; platform-admin only for null-tenant rows; add `@@index([restaurantId, createdAt])`.
Files: `src/instrumentation.ts`, `src/app/api/health/errors/route.ts`, `prisma/schema.prisma`

---

## 3. HIGH / MEDIUM / LOW

### HIGH (one line each)
1. Invoice numbers minted COUNT(*)+1 in server-local year with no retry — concurrent settlements abort the payment after cash changed hands; per-tenant counter row (FOR UPDATE) + tz-aware year + bounded retry (payments/service.ts:291; 3 auditors).
2. Refunds overwrite the Payment row in place (reason→failureReason, no actor/timestamp, full-amount only) — add a Refund model, keep Payment PAID/immutable, derive net; this also ends the payment-mix-vs-drawer disagreement by construction.
3. No refund or void UI anywhere — refundOrderPayment has zero callers outside scripts; a paid bill is permanently uncorrectable in production.
4. Partial/split payment unreachable — settle dialog posts the full due with no amount field, so spec 10/11 cannot be performed; add amount input + running balance (server already validates the ceiling).
5. BANK_TRANSFER not accepted by collectPaymentSchema, no OTHER enum value, WALLET/ONLINE till buttons have nothing behind them — drive buttons from paymentConfig, require a reference for transfers.
6. Cash tendered < amount is accepted silently and the `due + 1` slack lets a settled bill keep taking payments — reject short tender, make the ceiling exact.
7. A guest's bank-transfer reference is discarded when no UNPAID intent row exists — create the UNPAID BANK_TRANSFER payment row and carry the reference into the notification (spec 9).
8. Invoice exists only after full settlement, the emailed invoice link 404s, issuance is never audited, and the snapshot omits foodId/rates/option deltas/payments — finalize at bill presentation, add the route, audit INVOICE_ISSUED, snapshot v2.
9. Tax-inclusive refund amounts are netted off a pre-tax revenue base and the profit apportionment ratio can exceed 1 — split refunds into components, clamp the ratio.
10. Stock depletes outside the authoritative event: guest edit and line-void reconcile unconditionally on never-accepted PENDING orders — extract and share rebalanceDepletion's `applied === 0` guard (2 auditors).
11. Guests can edit PREPARING/READY orders and quantity=0 hard-deletes the OrderItem with no event — gate guest edits to QUEUED lines, replace delete with CANCELLED + OrderEvent.
12. No TableSession entity: the sitting is a client-side fold keyed on tableId, multi-round tables mint multiple invoices, and a prior party's open order merges into the next party's card — add the model, backfill, key folds and settlement on it (spec 65/70).
13. Waiter "Serve all" throws INVALID_TRANSITION on every partially-ready order — the board's common case; fan out per item via updateItemStatus + deriveOrderStatus.
14. costPerUnit is free-text editable on the item form with no movement and no audit — instant silent revaluation of shelf, future COGS and every recipe; make it create-only.
15. WAC arithmetic loses money: Int minor-units-per-base rounds ~0.4% away per receipt (spec 26's own example unrepresentable) and negative-stock blends discard carried value — carry stockValue / migrate cost columns to Decimal.
16. Negative-stock policy is checked restaurant-wide only; branch InventoryStock goes negative with no guard — apply the same rule to the branch position inside postMovement (2 auditors).
17. No value-based reconciliation, no valuation report, no as-at costing — spec 101's money ladder is unanswerable and SALE_REVERSAL/TRANSFER_IN rows carry unitCost 0; stamp cost on every row, add value columns to the ladder, build the valuation page.
18. No daily close, no accountant daily report, no accounting periods or lock, no cross-domain reconciliation dashboard, no consistency checks, no integrity checker, no OK/WARNING/ERROR statuses (specs 50/51/59/75/76/115/116) — the largest scoped gap; must be built on the unified modules only.
19. Outstanding receivable appears in no report and `SalesTotals.collected` is a billed figure with a payments name — add revenue / collected / outstanding side by side (specs 46/47/111).
20. Drill-down is absent everywhere: StatCard has no href, sales/profit tables link nowhere, order detail omits cost and recipe — spec 57/122's chain cannot be walked at any step (targets already exist and are good).
21. Exports: summary/orders ignore `?preset=` (file covers a different period than the screen), no title/period/filters/currency header, table CSVs dump raw minor units, 10k truncation is silent (specs 88/89).
22. Cancelled order lines still counted in the legacy COGS/top-items/category queries — mostly dies with getReportSummary's retirement; add line-status filters to the survivors.
23. All five cashier bill actions (hold/resume/split/merge/void) have no branch check — a site-scoped cashier can void or merge another branch's bills; add assertRecordBranch, refuse cross-branch merges.
24. Notification.audience is written but never enforced on the bell (the only prod channel) — waiters and cooks read named cash-variance and management alerts; add the audience predicate, gate hrefs.
25. Audit trail gaps: PRICE_CHANGED/RECIPE_CHANGED/INVOICE_ISSUED/INVOICE_REPRINTED etc. have zero callers, only 25/120 calls carry `before`, and settings/financial-config, item-master and recipe-activation changes are invisible (specs 60/61).
26. The printed receipt omits loyalty, tip, rounding and the PAYMENTS→BALANCE tail — the guest's paper total cannot be produced from its own visible lines (specs 12/13); extend the one shared builder.
27. No print queue or agent — fire-and-forget iframe printing with silent failure, no retry, station printerName purely decorative (spec 80); a kitchen ticket that doesn't print is an order never cooked.
28. The offline page claims sync that does not exist — spec 81's one explicit prohibition; staff working through an outage lose every write while being told it's queued; tell the truth now, build the outbox later or never.
29. Ledger UI omits Unit Cost and Value columns and silently truncates at 200 rows beside a drift banner computed from the full ledger (spec 86).
30. Test lattice holes exactly where the CRITICALs live: nothing tests computeTotals directly, tax-inclusive mode, overpayment/void/bank-transfer, cross-report agreement, or the purchase→GRN→sale→COGS→report chain, and the runtime test tier skips to a green exit by default (specs 99/100).
31. Documentation: 8 of the 10 spec-106 documents missing; WAC, tax arithmetic, revenue recognition and COGS methodology written nowhere except source.

### MEDIUM (one line each)
1. Tip is folded into Order.grandTotal at settlement, mutating what the bill said the guest owed — compute the settlement target as grandTotal + tipAmount instead.
2. Loyalty points are priced from a pre-transaction read and decremented unconditionally — concurrent orders redeem the same points twice; conditional updateMany + non-negative CHECK.
3. Sales recognized on placedAt for all non-cancelled orders including PENDING — yesterday's printed report changes today; add an explicit recognition predicate in the shared revenue module.
4. No per-item taxable flag or item-level discount — spec 91/93 granularity unrepresentable (Food.taxRateBps/taxExempt, OrderItem.discountAmount, per-line tax in computeTotals).
5. Split/merge silently shrinks coupon/loyalty discounts (clamped to the new subtotal) and merge orphans CouponRedemption rows — apportion largest-remainder, assert halves sum to the original.
6. Split target loses tableNumber/channel/notes/guestCount/guestSessionId — blank KDS tickets and guests lose their bill.
7. splitOrderNumber is count-based with no retry — concurrent splits collide with a raw P2002.
8. Kitchen "today" stats and the invoice year use server-local midnight, not restaurant.timezone (nextOrderNumber already solves this; extract the helper).
9. The quick "record purchase" path skips GoodsReceipt and PurchasePriceHistory — half of price history exists depending on which screen was used; route it through receiveGoods.
10. FEFO ignores branch/location, swallows shortfall, and useFefo has no reader — cross-branch batch consumption and invisible batch drift.
11. Ledger COGS and P&L COGS are two independent, never-reconciled numbers, and the zero-snapshot fallback re-prices at today's cost (spec 90) — make the ledger authoritative, reconcile in a test.
12. Supplier "spend" counts unreceived POs and no rejection/on-time/average-cost metrics exist (spec 42) — base spend on received value.
13. Stock-count lines store no financial impact and the variance report re-prices history at today's cost — store unitCost/varianceValue at approval, cost the ADJUSTMENT movements.
14. Reconciliation and branch-comparison value stock at today's cost and today's stock regardless of the selected range — value at the cost in force at range.to.
15. Food-cost % denominator is all net sales, not net food sales, undocumented (spec 53) — restrict or rename and document.
16. Item/category profitability keyed by name (renames split history) and missing selling-price/recipe-cost columns (specs 54/55) — key by foodId.
17. Report filters: three incompatible URL vocabularies and most spec-58 dimensions missing — converge on `?preset/from/to/branch`.
18. Zero CHECK constraints in the database — negative payments and zero-quantity movements are storable; Zod is the only guard (spec 64).
19. Audit rows are written after commit on the global client and swallow failures — a frozen invocation leaves a committed money change unaudited; add auditTx inside the transactions for money/stock ops.
20. Rate limits fall back to a per-process Map — on Netlify, login/reset/QR-flood limits are no-ops; DB-backed counter for auth + trusted platform IP header.
21. StockMovement lacks [itemId,branchId,createdAt] and locationId indexes and the item page runs an unbounded lifetime aggregate — use the stored balanceAfter.
22. notifyLowStock fires inside the order transaction on the global client — phantom alerts on rollback, lost on freeze; collect and fire post-commit.
23. Branch-scoped managers see a false "books do not balance" banner on every item (restaurant-wide cache vs branch-filtered ledger) — compare against the branch-scoped InventoryStock sum.
24. ErrorLog trim guard is accidentally always-true and the 200-row cap is global across tenants — sample or age-trim per tenant.
25. No cross-item ledger view and no inventory overview; spec-87 metrics mostly absent and none drillable — add /dashboard/inventory/ledger and overview.
26. 27 unbounded findMany calls ship whole tables to the browser and the sales/profit reports materialize every row in Node — paginate lists, aggregate reports in SQL (specs 82/83/114).

### LOW (titles only)
Order-number format differs from spec 94 (YYMMDD-NNN, 999/day cap) · capturePayment's paymentId branch lacks tenant/order scoping (latent cross-tenant write) · PurchaseStatus lacks CLOSED, returns don't reverse receivedQty/price history, consumptionUnit unreachable · ledger rows mutated post-insert for linkage, no DB-level append-only guard · paid-up-front orders stuck PREPARING while the table releases to CLEANING · nextOrderNumber scans all of today's numbers per attempt · no per-item status transition table (waiter can serve uncooked items, skewing cook-time stats) · /api/media/[key] serves any asset by key with no tenant scope · notification href rendered into Link without shape validation · low-stock notification links to the list not the item, raw base-unit formatting, cross-branch dedupe hides second sites · socket-arrived notifications unclickable until reload · legacy export links drop the branch param · `collected` field misnamed · ReportFilters.onExport dead prop (RSC crash if ever used).

---

## 4. Preserve — the load-bearing list (deduped; regressions here are worse than the bugs above)

**Money**
1. `computeTotals` (pricing.ts:203-246): single deterministic integer billing engine, documented order of operations, tax-inclusive back-out, clamping — all four server write paths use it; never fork it, never trust a client total.
2. `recalculateOrderTotals` (cashier/service.ts:33-77): re-derives from surviving lines, filters CANCELLED, roundTotal:true so split→merge returns the original — this is the pattern applyManualDiscount must be folded into.
3. Server-side money authority end to end: POS bill returned from the server, change computed server-side, capturePayment recomputes due from the locked row — best-verified property in the audit (scored 5).
4. `src/lib/money.ts` integer minor units, applyBps half-up, roundToNearestMajor returning the adjustment.
5. capturePayment's FOR UPDATE on the order + overpayment ceiling + drawer attribution matching BOTH openedById and the order's branchId; refunds routed to the open drawer carrying paymentId so an unrecorded refund is a visible absence.
6. Historical snapshots: OrderItem freezes name/unitPrice/options/optionsTotal/lineTotal/costPrice/recipeId; Order freezes tableNumber/customer identity/taxRateBps/serviceChargeBps.
7. One receipt builder with three callers (receipt.ts) and escapeHtml on every interpolated print value — extend it, never add a fourth copy.

**Stock**
8. `postMovement` as the sole balance writer: FOR UPDATE under guardLocks (4s/9s timeouts), direction derived from type (unknown type throws), balanceAfter stamped, applyLocationDelta in the same transaction.
9. `reconcileOrderDepletion`'s declarative want-minus-have with OrderStockDepletion @@unique idempotency — run-twice-changes-nothing; do not make it incremental. `rebalanceDepletion` whole: applied===0 guard, sorted ids, recipeId following the moved remainder.
10. Reversal by SALE_REVERSAL movements, never deletion; cancelOrder's full compensation set (loyalty, coupon usedCount, totalOrders, conditional table release).
11. Recipe versioning: pinRecipeVersions fills only null, snapshotLineCosts sole costPrice writer filling only zeros, active-version partial unique indexes, make-ahead rule (prep recipes deduct the produced item), cycle/depth guards.
12. Deterministic unit conversion that throws instead of guessing; packaging resolved only via the item's own pack size.
13. Goods receiving as the only PO→stock path: accepted/rejected split, over-receipt refused under lock, status derived from lines, batch + PurchasePriceHistory per receipt.
14. Two-step stock counts (systemQty snapshotted once, branch-scoped baseline, self-approval refused, FOR UPDATE + compare-and-swap approval); wastage as first-class snapshot-costed records; transfers with reserved/inTransit separated and both directions ledger-posted.

**Concurrency & identity**
15. Order numbering: MAX-derived in the restaurant's timezone, @@unique + ten-attempt jittered retry, idempotency-key loser returns the winner's order; placeOrder's read-then-write transaction shape.
16. BRANCH_TABLE_MISMATCH guard, branch-in-path guest routing, NOBODY_SEATED including CLEANING/RESERVED, new-QUEUED-line rule for increments on cooked lines, item-driven waiter ready list, two-direction status model with ladder replay, per-item first-entry timestamps.
17. Advisory-lock patterns in purchasing/transfers (pg_advisory_xact_lock — pooler-safe); reuse for invoice numbering rather than replacing.

**Security & platform**
18. Guard architecture (requirePermission/assertBranchAccess/assertRecordBranch), the four-way role-escalation vet, feature-plan gating with lockedByPlan and super-admin-only entitlements, audit-log immutability + credential redaction.
19. Branch scoping semantics: empty allow-list renders `AND false`, never no-filter; assertRecordBranch on collectPayment/refundOrderPayment as the template; per-branch cache keys on dashboard analytics.
20. `/api/pulse` scoped change tokens + AutoRefresh per-screen intervals — the entire prod live channel; the SW's refusal to cache /dashboard and /api.

**Reporting & ops**
21. `profit.ts` gross-only framing, disclaimer on every response, pro-rata apportionment, snapshot-cost preference, recipe-coverage blind-spot reporting; cash reports' session-by-openedAt totals summed from the same rows shown; the drawer's takings-vs-variance separation; `range.ts` as the one timezone-correct resolver everything must converge on.
22. The verify-all three-tier harness and its honesty about SKIPPED; page-render-test; the break-the-books reconciliation test; the static guard scripts (no-item-branch-filter, no-unguarded-feature-pages, no-function-props, no-raw-action-calls); loading/error boundary pair; instrumentation digest capture (fix scoping, keep the mechanism); the help page; typed AppError/runAction and the existing error-message quality.

---

## 5. Database migration requirements (grouped by the slice that lands them)

**Slice 1 (data-only fix-up):** null out Order.customerId pointing at `phone=''` Customer rows per restaurant, zero those rows' loyaltyPoints; partial unique index on Customer.phone excluding `''` (full nullable-phone change in Slice 2). Populate ErrorLog.restaurantId going forward + `@@index([restaurantId, createdAt])`.

**Slice 2:** `Order.couponDiscount Int @default(0)` + `Order.manualDiscount Int @default(0)` (backfill manualDiscount = discountTotal − COALESCE(redemption.amount,0)); new `Refund` model (restaurantId, paymentId, orderId, amount, reason, refundedById, refundedAt, cashMovementId?) with backfill of one row per existing REFUNDED payment; `RestaurantCounter { restaurantId, series, year, value }` for invoice (and later order/split) numbering; PaymentMethod enum + OTHER; Customer.phone nullable; `Customer.loyaltyPoints >= 0` CHECK; raw-SQL CHECK migration (payments.amount ≥ 0, stock_movements.quantity ≠ 0, inventory_items.costPerUnit ≥ 0, orders totals ≥ 0 — NOT VALID then VALIDATE); `Invoice.issuedById`.

**Slice 3:** VariantOption.recipeId (or VariantOptionIngredient join) — additive; cost-precision migration: costPerUnit/lastPurchaseCost/StockMovement.unitCost/StockBatch.unitCost/PurchasePriceHistory.unitCost → Decimal(18,6) (or documented ×1000 Int scale) + `InventoryItem.stockValue` if value-carrying WAC chosen; StockMovement `@@index([itemId, branchId, createdAt])` and `@@index([restaurantId, locationId, createdAt])` (CONCURRENTLY); `@@unique([restaurantId, sku])` partial; StockCountLine.unitCost/varianceValue (backfill once at current cost); PurchaseStatus + CLOSED.

**Slice 4:** none required (invoice snapshot v2 is a versioned JSON field); optional Food.taxRateBps/taxExempt + OrderItem.discountAmount if spec 91/93 granularity ships here.

**Slice 5:** `TableSession` model + `Order.tableSessionId` with backfill grouping open-order runs per table; `DailyClose { restaurantId, branchId, businessDate, status, closedById, snapshot Json, @@unique }`; `AccountingPeriod { restaurantId, branchId?, kind, startsAt, endsAt, status, closedById }` + assertPeriodOpen guards.

**Slice 6:** `PrintJob` model (status QUEUED|PROCESSING|PRINTED|FAILED, attempts, lastError); MediaAsset visibility + restaurantId (backfill PUBLIC); optional RateLimitCounter table; optional stock_movements append-only trigger.

All are additive or backfilled; nothing rewrites existing order/invoice numbers or ledger rows.

---

## 6. Exact implementation order — 7 slices, each independently green and committable

Ordering rule applied: (a) stored-money/stock corruption before read-side lies — corrupted stored data is unrecoverable, wrong reports can be re-run once fixed; (b) dependencies (Refund model before refund UI; unitCost stamping before the value ladder; unified modules before the daily close); (c) spec §118 phase order as tiebreaker (DB/tenancy/RBAC early → billing/payments → inventory chain 16–28 → reports 32–33 → printing/PWA 34–36 → hardening 38 → testing 40). Note: §118 puts table sessions at Phase 7, but in a brownfield remediation TableSession lands in Slice 5 because it reuses the repaired settlement/mergeBills machinery and blocks nothing financial — rule (a) outranks the greenfield sequence. Every slice lands with its own regression tests registered in scripts/verify-all.ts. **The uncommitted working tree is not committed as-is; Slice 1 fixes it forward.**

**Slice 1 — Stop the bleeding (pure-logic guards, ~zero schema).**
Contains: C1 authoritative guest-edit payload; C2 code path (no Customer on blank phone, reject guest redeemPoints, data fix-up script); C3 discount permission + approval wiring; C4 single cancellation entry point + `paidTotal > 0` guard + updateItemStatus CANCELLED delegation; C5 first half (applyManualDiscount → recalculateOrderTotals); C6 refund lock; C10's five one-liners (report timeZone + refund branch predicate); C11 error-log tenant scoping; H10 shared `applied === 0` depletion guard; H11 guest-edit status gate / no hard delete; H6 tender validation + exact ceiling; H23 assertRecordBranch on all five cashier actions.
Why first: every item is silent money-out, stock corruption or cross-tenant exposure reachable in production today; each is a small, independently testable diff with no design decisions; covers spec phases 2–4 concerns (integrity/tenancy/RBAC) per §118.

**Slice 2 — Payment & discount model made spec-shaped (migration set A).**
Contains: coupon/manual discount split (finishes C5); Refund model + backfill + partial refunds, Payment immutable (H2); refund UI on order detail + amount field/split-settle UI on the till (H3/H4); invoice numbering via counter + tz year + retry (H1); BANK_TRANSFER/OTHER + config-driven till buttons (H5); guest transfer reference as UNPAID row (H7); receipt completion — loyalty/tip/rounding/payments/balance in the one shared builder (H26); tip out of grandTotal (M1); loyalty conditional decrement + CHECK (M2); CHECK-constraint migration (M18).
Why second: depends on Slice 1's correctness; these schema changes make every payment record carry amount/actor/timestamp/status (spec 5/61) and unblock reconciliation reports and refund reporting downstream; §118 phases 13–15.

**Slice 3 — Inventory truth: consumption and costing.**
Contains: variant/add-on consumption (C7); unit-change lock (C8); costPerUnit create-only + item-master audit (H14); WAC value-carrying + Decimal precision (H15); branch-level negative-stock enforcement (H16); unitCost stamped on SALE_REVERSAL/TRANSFER_IN/CUSTOMER_RETURN rows (prereq for Slice 4's value ladder, part of H17); FEFO branch filter + shortfall surfacing (M10); quick-purchase through receiveGoods (M9); stock-count financial impact (M13); StockMovement indexes + balanceAfter instead of lifetime aggregate (M21); notifyLowStock post-commit (M22).
Why third: §118 phases 16–28; independent of Slice 2's schema; must precede reporting because the value ladder and valuation report read the costs this slice starts recording correctly.

**Slice 4 — One source of numbers (reports unification).**
Contains: retire getReportSummary — dashboard, reports screen and exports onto getSalesReport/getProfitReport (finishes C9); revenue-recognition predicate + tz-correct hour/day buckets (M3/M8); refund component apportionment + ratio clamp (H9); cancelled-line filters in surviving raw queries (H22); outstanding + revenue/collected side-by-side collections view (H19); export headers/rendered values/canonical range/truncation notice (H21); drill-down — StatCard href, hrefTemplates on sales/profit, foodId keying, order-detail cost/recipe block (H20, M16); value ladder + valuation report + as-at costing (H17, M14); ledger UI cost/value columns + paging + false-drift banner fix (H29, M23); wastage range param (reports HIGH); filter vocabulary convergence (M17); scripts/report-agreement-test.ts + range/timezone test.
Why fourth: read-side — safe to do once Slices 2–3 have made the underlying rows correct; §118 phase 32; the agreement test locks spec 102's identity permanently.

**Slice 5 — Structural entities: sittings, invoices, the close.**
Contains: TableSession model + backfill + session-keyed folds + settle-a-session via the repaired mergeBills (H12); invoice finalized at bill presentation + /invoice route + INVOICE_ISSUED audit + snapshot v2 (H8, M2-snapshot); split/merge discount apportionment + split snapshot fields + splitOrderNumber via the counter (M5/M6/M7); waiter serve-all fan-out (H13); kitchen-stats/invoice-year tz helper (M8 remainder); DailyClose + the spec-51 daily report composing the now-single-source modules; AccountingPeriod + assertPeriodOpen on payments/refunds/adjustments/count-approval (H18 core).
Why fifth: the daily close must compose unified modules (Slice 4) or it becomes a fourth revenue definition; TableSession reuses Slice 1/2's repaired cancellation and settlement; §118 phases 7 and 33 meet here deliberately (see ordering note).

**Slice 6 — Audit, hardening, ops truth.**
Contains: audit before/after norm + PRICE_CHANGED/RECIPE_CHANGED wiring + settings/recipe-activation/toggle audits + auditTx inside money/stock transactions (H25, M19); notification audience enforcement + href validation + low-stock link/format fixes (H24, LOWs); rate limiting DB-backed for auth + trusted IP header (M20); media asset visibility/tenant scope (LOW); ErrorLog trim/retention fix (M24); PrintJob queue + failure surfacing + honest printerName (H27); offline-claim truthfulness (H28); pagination for the unbounded findMany sites + SQL aggregation for report internals (M26); cross-item ledger + inventory overview pages (M25); integrity checker + OK/WARNING/ERROR checks module (finishes H18, specs 75/76/115/116).
Why sixth: §118 phases 34–39; everything here either hardens or makes visible what Slices 1–5 made correct; the integrity checker needs correct invariants to check.

**Slice 7 — Test lattice and documentation.**
Contains: scripts/e2e-reconciliation-test.ts implementing spec 101's worked example end to end (PO 100kg@800 → GRN → sale 50kg → waste 5kg → sales/profit/valuation/reconciliation all agree, purchases ≠ COGS); billing-math matrix incl. tax-inclusive, 0%/100% discount, rounding; payment matrix incl. overpayment/void/BANK_TRANSFER/concurrent invoice numbers; runtime tier mandatory in CI (`verify:full`, non-zero on skip); phase11-perf wired with thresholds (H30); ACCOUNTING.md, INVENTORY.md, TESTING.md first, then SECURITY/DATABASE/ARCHITECTURE/REPORTING/API.md; help-page methodology sections (H31).
Why last as a slice — but not as an activity: each earlier slice ships its own regression tests; this slice adds the cross-cutting matrix that proves the §121 reconciliation identities and the §122–125 accountant tests hold as a system, and writes down the methodology so they stay held. §118 phases 40–41.
---

## 8. Re-scored scorecard (§120) — after the seven slices, 2026-09-02

Scored against the same rules as the Phase 0 audit: no unearned 5s, every
score with evidence, every remaining issue named. Evidence cites code and the
test that pins it; "verified" means it runs green in the three-tier harness
(1,900+ checks, runtime tier mandatory).

| Area | Score / 5 | Evidence | Remaining issues |
| --- | ---: | --- | --- |
| Architecture | **4** | Single engines for every hard problem (computeTotals, postMovement, reconcileOrderDepletion, cancelOrder, ensureInvoice, resolveRange, nextCounterValue — ARCHITECTURE.md); the spec's missing entities all exist (Refund, TableSession, DailyClose, AccountingPeriod, PrintJob, LoyaltyEntry); one revenue definition product-wide (report-agreement-test) | Realtime off in prod by design (polling); no offline capability |
| Multi-tenancy | **4** | restaurantId from session only; error log tenant-scoped with verified-cookie attribution; all five cashier bill actions branch-pinned; branch guards fail closed; integrity check for tenancy breaks | Plan gating (availablePermissions) coarse-grained |
| Database | **4** | Migrations-only with hand-curated diffs; first CHECK constraints (money floors, loyalty, refunds); ledgers + recomputable caches verified by runIntegrityChecks; atomic counters; movement/branch indexes; SKU unique | Parked `recipe_items` table awaits removal; quantities are Float-with-rounding, not Decimal |
| Authentication | **4** | JWT access + rotating refresh, httpOnly; separate admin session; guest session cookies gate order access (guest-edit-test §5) | No 2FA / device management |
| RBAC | **4** | Saved roles REPLACE presets (deny works); plan intersection; per-user grants; page/feature/permission agreement enforced by static guard; ACCOUNTING_CLOSE withheld from auditors by design | No per-branch role variants |
| QR Ordering | **4** | Idempotent placement; authoritative guest-edit payload (C1, guest-edit-test over real HTTP); no shared walk-in identity (C2); QUEUED-only guest edits, cancel-not-delete | No guest-side payment (by design, §6) |
| Orders | **4** | One cancellation entry point with paidTotal guard (C4); period sealing on history; status ladder with truthful timestamps; TableSession lifecycle (structural-test) | Modifiers not editable post-placement by guests (deliberate) |
| KDS | **4** | Per-section routing, all-or-nothing acceptance with named-dish refusals, derived order status, reject → cancelOrder with reasons | No hardware bump-bar integration |
| Waiter | **4** | Serve-all walks the ladder from PREPARING (structural-test §3); item-level serving; audience-scoped bell | Floor map basic |
| POS | **4** | Split/partial settle via amount field; BANK_TRANSFER/OTHER recordable with references; server-priced bills; drawer attribution by branch | Method buttons not yet config-per-restaurant |
| Billing | **5** | One deterministic integer engine for every path; 96-combination matrix + clamping/rounding/tip rules pinned (billing-math-test); discount split preserved to the DB; recalc after every line change; sum(lines)=subtotal enforced by integrity checker | — |
| Payments | **4** | Immutable payments + Refund ledger with partials; FOR UPDATE against double-settle and double-refund (payment-model-test races); approval thresholds enforced; paidTotal recomputed-by-sum | Guest transfer claims rely on cashier confirmation flow |
| Cash reconciliation | **4** | Drawer sessions with tolerance + owner-only variance review; refunds hit the open drawer; daily close freezes variance beside takings; §46 side-by-side | Multi-drawer-per-branch scenarios thin |
| Inventory | **4** | Sole-writer ledger; branch-level negative guard (recipe-costing-test updated deliberately); unit lock (C8); cost create-only; FEFO per branch | Par-level suggestions basic |
| Inventory ledger | **5** | postMovement owns every balance; FOR UPDATE + guardLocks; value-carrying WAC with stamped costs on every row including reversals; cross-item ledger screen; integrity replay (balances vs movements, shelves vs totals) green; §101 ladder closes with zero drift | — |
| Purchasing | **4** | GRN as the PO→stock path; quick purchase through the same ledger with counter numbers and lots; branch-attributed spend | Approval thresholds for POs not wired to ApprovalRequest |
| Suppliers | **4** | Ledgered balances; accountant may settle, not edit | No supplier statements export |
| Recipes | **4** | Versioning with pinning at acceptance; sub-recipes, yields, wastage %; variant options consume recipes (C7, inventory-truth-test §4) | No recipe cost trend view |
| Costing | **4** | Weighted average carried as exact value; snapshots at acceptance; menu-price fallback only for recipe-less dishes | Historical pre-snapshot lines remain uncosted |
| COGS | **4** | Ledger-derived, option-inclusive, pinned-version; purchases ≠ COGS held end to end (e2e-reconciliation-test) | COGS by daypart not broken out |
| Waste | **4** | Ledgered with reasons, valued at average, in the value ladder and daily close | Photo evidence not supported |
| Stock counts | **4** | Maker-checker with self-approval only for owners; stored-variance posting; signed money impact in the audit trail (inventory-truth-test §5) | No blind-count mode |
| Inventory valuation | **4** | stockValue exact per item; valuation figures on reconciliation screen and ledger; movement rows individually valued | No valuation-by-category report page |
| Customers | **4** | No shared walk-in row (C2 retired with data fix-up); branch-scoped visibility; live-board tiers honest | Merge-duplicate-customers tool absent |
| Loyalty | **4** | Full ledger (§72) with conditional decrement beating the double-spend race; balance = Σ entries enforced by integrity checker; public redemption removed | Earn base still includes tax (candidate refinement) |
| Coupons | **4** | Server-validated limits, per-customer caps, redemption rows recording the coupon's own take; split/merge apportionment | Stacking rules single-coupon only |
| Reservations | **3** | Feature present and tenant-scoped | Untouched by this remediation; depth unverified |
| Sales reports | **4** | §110 definition, tz-correct, branch-summing, refund-aware, drillable | Custom range picker basic |
| Accounting reports | **4** | Daily close (§51 snapshot), sealed periods (§59), integrity statuses (§116) on one screen | No P&L statement layout; close snapshots not yet exportable |
| Reconciliation | **5** | Quantity AND value ladders vs stored balances; 14-check integrity engine proven by breaking the books on purpose (hardening-test); §101 worked example green end to end with purchases ≠ COGS | — |
| Printing | **3** | Every print recorded with exact payload, PRINTED/FAILED, reprint-identical (§80); honest 58/80mm widths | Browser printing only — no server print queue/retry to hardware |
| Realtime | **3** | Honest polling via scoped /api/pulse; sockets clean but disabled in prod | No SSE/streaming alternative on the serverless host |
| PWA | **3** | Installable; offline page now tells the truth (§81) | No offline order queue (deliberately — but that caps the score) |
| Security | **4** | See SECURITY.md; static guards enforce page/feature agreement; rate limits real on serverless; audits with before/after | No CSP headers audit; no pen test |
| Performance | **3** | Indexed hot paths; polling tuned; unbounded reads capped where they feed UI | Report aggregation in JS not SQL for large ranges; no load testing |
| Testing | **5** | Three tiers, 1,900+ checks, runtime tier mandatory (fails when skipped); races tested as races; proof suites for §101/§102; deliberate-pin-change discipline; the integrity checker caught the suite's own dishonest fixtures | No headless-browser tier (Server Actions covered over HTTP instead) |
| Deployment | **4** | Netlify auto-deploy from main; migrations via db:deploy:safe; additive-only with backfills; local rehearsal before push | Single environment — no staging |
| UI/UX | **4** | Drill-down from every headline (§57); calm-by-default drawer close; honest empty/error states; receipts explain their own totals (§92) | Design-system consistency pass pending |
| Accessibility | **3** | Semantic tables/labels/focus states throughout | Never formally audited |
| Documentation | **4** | ACCOUNTING/INVENTORY/REPORTING/TESTING methodology docs; ARCHITECTURE/DATABASE/SECURITY/API; README index; in-app methodology help (§9b) | API.md thin (no public API by design) |

**Reading the line:** the money and stock core — billing, ledger,
reconciliation, testing — now earns its 5s with running proof; nearly
everything else sits at an honest 4 with its remaining issue named; the 3s
(reservations, printing hardware, realtime, PWA, performance-at-scale,
accessibility) are the areas the seven slices deliberately did not reach.
The Phase 0 verdict — "the write paths are strong, the read side lies, the
accounting layer does not exist" — no longer describes this system.
