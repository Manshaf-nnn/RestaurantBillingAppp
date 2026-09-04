-- The three CHECK constraints AUDIT.md's Slice 2 specified and that never landed.
--
-- Slice 2's migration set called for "payments.amount >= 0, stock_movements.quantity
-- <> 0, inventory_items.costPerUnit >= 0, orders totals >= 0 — NOT VALID then
-- VALIDATE". Only the orders one shipped (plus loyalty points and refund amounts).
-- The other three are still enforced in application code alone:
--
--   * postMovement refuses a zero quantity with STOCK_BAD_QUANTITY, but nothing
--     stops a direct write, a repair script or a future code path from storing a
--     movement that moves nothing — a ledger row that cannot be reversed because
--     there is nothing to reverse.
--   * capturePayment clamps to the outstanding amount, but no rule stops a
--     negative payment being stored, which would silently reduce takings while
--     every balance check stayed green.
--   * A negative costPerUnit turns cost of sales negative and reads as profit.
--
-- NOT VALID first, VALIDATE second, per the house pattern: ADD ... NOT VALID takes
-- only a brief ACCESS EXCLUSIVE lock and does not scan the table, then VALIDATE
-- scans under a weaker SHARE UPDATE EXCLUSIVE lock that does not block reads or
-- writes. On a live database with a large stock_movements table, adding it in one
-- step would lock the ledger for the length of a full scan.
--
-- If VALIDATE fails, the database already holds rows these rules forbid. That is
-- worth knowing rather than working around: find them, understand how they were
-- written, and correct them before re-running.

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_amount_nonneg" CHECK ("amount" >= 0) NOT VALID;
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_amount_nonneg";

-- Not "> 0": the legacy ADJUSTMENT type carries its own sign, so a correction
-- downwards is a legitimately negative quantity. What is never legitimate is a
-- movement of nothing.
ALTER TABLE "stock_movements"
    ADD CONSTRAINT "stock_movements_quantity_nonzero" CHECK ("quantity" <> 0) NOT VALID;
ALTER TABLE "stock_movements" VALIDATE CONSTRAINT "stock_movements_quantity_nonzero";

ALTER TABLE "inventory_items"
    ADD CONSTRAINT "inventory_items_cost_nonneg" CHECK ("costPerUnit" >= 0) NOT VALID;
ALTER TABLE "inventory_items" VALIDATE CONSTRAINT "inventory_items_cost_nonneg";
