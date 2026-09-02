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
-- LEAST caps the product inside numeric(18,6)'s twelve integer digits, and
-- the < 'Infinity' guard excludes both Infinity and NaN (Postgres orders NaN
-- above Infinity, so neither passes) — a poisoned float row must not abort
-- the whole file.
UPDATE "inventory_items"
SET "stockValue" = LEAST(GREATEST(0, "quantity") * "costPerUnit", 999999999999.0)
WHERE "quantity" > 0 AND "costPerUnit" > 0 AND "quantity" < 'Infinity'::float8;

-- The per-branch ledger walk the reconciliation report performs.
CREATE INDEX "stock_movements_itemId_branchId_createdAt_idx"
  ON "stock_movements"("itemId", "branchId", "createdAt");

-- Two items sharing a SKU is how the wrong thing gets scanned out.
--
-- The index cannot be created over existing duplicates, and production HAD
-- some — this exact statement failed the 2026-09-02 deploy with P3009 while
-- the local check came back clean. The pre-clean below resolves any
-- duplicate claim deterministically: the OLDEST item keeps the SKU (it made
-- the claim first), later claimants lose theirs to NULL — which the unique
-- index permits, and which reads honestly in the UI as "no SKU assigned,
-- pick a real one". Nothing is deleted, nothing is invented.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "restaurantId", "sku"
           ORDER BY "createdAt" ASC, id ASC
         ) AS rn
  FROM "inventory_items"
  WHERE "sku" IS NOT NULL
)
UPDATE "inventory_items" i
SET "sku" = NULL
FROM ranked r
WHERE r.id = i.id AND r.rn > 1;

CREATE UNIQUE INDEX "inventory_items_restaurantId_sku_key"
  ON "inventory_items"("restaurantId", "sku");
