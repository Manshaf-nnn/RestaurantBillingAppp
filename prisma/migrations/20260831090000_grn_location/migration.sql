-- Where a delivery actually landed.
--
-- Receiving was hard-wired to the purchase order's own branch, so a van
-- diverted to another site could not be recorded truthfully: the stock went
-- onto the wrong shelf in the books and the difference surfaced weeks later as
-- a variance nobody could account for.
--
-- Both columns are nullable and mean "wherever the order said", so every
-- existing receipt keeps its current behaviour with no back-fill.

ALTER TABLE "goods_receipts" ADD COLUMN "branchId" TEXT;
ALTER TABLE "goods_receipts" ADD COLUMN "locationId" TEXT;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The receiving screen lists deliveries by date across all orders.
CREATE INDEX "goods_receipts_restaurantId_receivedAt_idx"
    ON "goods_receipts"("restaurantId", "receivedAt");
