-- DropIndex
DROP INDEX "inventory_stock_itemId_branchId_key";

-- CreateIndex
CREATE INDEX "inventory_stock_itemId_branchId_storageLocationId_idx" ON "inventory_stock"("itemId", "branchId", "storageLocationId");


-- Uniqueness, expressed as two partial indexes.
--
-- A plain UNIQUE (itemId, branchId, storageLocationId) would not hold: Postgres
-- treats NULLs as distinct, so stock with no shelf assigned could accumulate
-- duplicate rows for the same item and branch. Splitting the constraint on
-- whether a shelf is set covers both cases exactly once.
CREATE UNIQUE INDEX "inventory_stock_item_branch_nostorage_key"
  ON "inventory_stock" ("itemId", "branchId")
  WHERE "storageLocationId" IS NULL;

CREATE UNIQUE INDEX "inventory_stock_item_branch_storage_key"
  ON "inventory_stock" ("itemId", "branchId", "storageLocationId")
  WHERE "storageLocationId" IS NOT NULL;
