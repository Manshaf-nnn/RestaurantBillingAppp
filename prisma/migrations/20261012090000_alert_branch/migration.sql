-- "Alert me below" can watch one location instead of the overall stock.
-- Null keeps the old behaviour: the threshold is held against the stock in
-- view, which with no location chosen is the total across all of them.
ALTER TABLE "inventory_items" ADD COLUMN "alertBranchId" TEXT;

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_alertBranchId_fkey"
  FOREIGN KEY ("alertBranchId") REFERENCES "branches"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
