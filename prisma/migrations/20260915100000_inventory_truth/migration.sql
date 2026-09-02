-- Inventory truth (AUDIT.md Slice 3).

-- What choosing a variant option consumes (C7). "Extra chicken" was food
-- leaving the kitchen that no ledger ever saw.
ALTER TABLE "variant_options" ADD COLUMN "recipeId" TEXT;
ALTER TABLE "variant_options" ADD CONSTRAINT "variant_options_recipeId_fkey"
  FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "variant_options_recipeId_idx" ON "variant_options"("recipeId");

-- Value-carrying WAC (§39): the worth of stock on hand, exact, so per-unit
-- rounding stops bleeding pennies on every movement. Backfilled from the
-- rounded cache — the best approximation history allows.
ALTER TABLE "inventory_items" ADD COLUMN "stockValue" DECIMAL(18,6) NOT NULL DEFAULT 0;
UPDATE "inventory_items"
SET "stockValue" = GREATEST(0, "quantity") * "costPerUnit"
WHERE "quantity" > 0 AND "costPerUnit" > 0;

-- The per-branch ledger walk the reconciliation report performs.
CREATE INDEX "stock_movements_itemId_branchId_createdAt_idx"
  ON "stock_movements"("itemId", "branchId", "createdAt");

-- Two items sharing a SKU is how the wrong thing gets scanned out.
-- (Verified duplicate-free before this migration; NULLs stay distinct.)
CREATE UNIQUE INDEX "inventory_items_restaurantId_sku_key"
  ON "inventory_items"("restaurantId", "sku");
