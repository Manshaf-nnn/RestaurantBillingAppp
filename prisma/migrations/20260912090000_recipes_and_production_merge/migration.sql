-- Recipes and production: four ideas down to two.
--
-- Four different things in this app meant "recipe": the menu dialog's Recipe
-- tab (`recipe_items`), the versioned `recipes` table, `production_specs`, and
-- `recipes.producesItemId` — which had no create UI at all. This migration
-- folds the first and third into `recipes`, and removes the production batch
-- multiplier by restating run quantities in output units.
--
-- Nothing is dropped. `recipe_items` and `production_specs` keep their rows so
-- a bad backfill is one UPDATE from repair rather than unrecoverable.

-- ── new columns ─────────────────────────────────────────────────────────────

ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "shelfLifeDays" INTEGER;

ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "recipeId" TEXT;
-- Snapshotted, so a completed run stays readable with no live dependency on
-- the recipe row — the same discipline `production_consumption.unitCost` uses.
ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "recipeName" TEXT;

-- ── 1 · the menu dialog's Recipe tab → recipes ──────────────────────────────
--
-- Lossless: `recipe_items.quantity` is documented as being in the inventory
-- item's own unit, and that unit IS the base unit, so it maps 1:1 at zero
-- wastage on a recipe yielding one portion.
--
-- The NOT EXISTS guard keeps the versioned recipe wherever a food has both,
-- which is exactly what the resolver already preferred — so a food that had
-- both changes behaviour not at all, and its `recipe_items` rows were already
-- dead code.

INSERT INTO "recipes" (
  id, "restaurantId", "foodId", name, version, "isActive", "yieldQty",
  "createdAt", "updatedAt"
)
SELECT DISTINCT ON (f.id)
  'legacy_' || f.id, f."restaurantId", f.id, NULL, 1, TRUE, 1, NOW(), NOW()
FROM "foods" f
JOIN "recipe_items" ri ON ri."foodId" = f.id
WHERE NOT EXISTS (
  SELECT 1 FROM "recipes" r
   WHERE r."foodId" = f.id AND r."isActive" AND r."archivedAt" IS NULL
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "recipe_ingredients" (
  id, "recipeId", "inventoryItemId", quantity, unit, "wastagePercent",
  "sortOrder", "createdAt"
)
SELECT 'legacyi_' || ri.id, 'legacy_' || ri."foodId", ri."itemId", ri.quantity,
       ii.unit, 0, 0, NOW()
FROM "recipe_items" ri
JOIN "inventory_items" ii ON ii.id = ri."itemId"
WHERE EXISTS (SELECT 1 FROM "recipes" r WHERE r.id = 'legacy_' || ri."foodId")
ON CONFLICT (id) DO NOTHING;

-- ── 2 · production specs → recipes ──────────────────────────────────────────
--
-- Deterministic ids ('spec_' || id) so this is idempotent and provenance stays
-- readable in the database itself.
--
-- Only ONE spec per output item may stay active, because `recipes` has no
-- uniqueness on "one active version per owner" — it is a convention that
-- `findFirst(orderBy: version desc)` happens to honour, and N active rows would
-- make the resolver pick one arbitrarily. The partial indexes at the end of
-- this file turn that convention into a constraint.

INSERT INTO "recipes" (
  id, "restaurantId", "producesItemId", name, version, "isActive",
  "yieldQty", "yieldUnit", "shelfLifeDays", "prepNotes", "createdAt", "updatedAt"
)
SELECT
  'spec_' || ps.id,
  ps."restaurantId",
  ps."outputItemId",
  ps.name,
  1,
  ps."isActive"
    AND ps.id = (
      SELECT p2.id FROM "production_specs" p2
       WHERE p2."restaurantId" = ps."restaurantId"
         AND p2."outputItemId" = ps."outputItemId"
         AND p2."isActive"
       ORDER BY p2."updatedAt" DESC, p2.id DESC
       LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM "recipes" r
       WHERE r."restaurantId" = ps."restaurantId"
         AND r."producesItemId" = ps."outputItemId"
         AND r."isActive" AND r."archivedAt" IS NULL
    ),
  ps."outputQty",
  ii.unit,
  ps."shelfLifeDays",
  ps.notes,
  ps."createdAt",
  ps."updatedAt"
FROM "production_specs" ps
JOIN "inventory_items" ii ON ii.id = ps."outputItemId"
ON CONFLICT (id) DO NOTHING;

-- COALESCE because `production_spec_items.unit` is nullable and
-- `recipe_ingredients.unit` is NOT NULL.
INSERT INTO "recipe_ingredients" (
  id, "recipeId", "inventoryItemId", quantity, unit, "wastagePercent",
  "sortOrder", "createdAt"
)
SELECT 'speci_' || psi.id, 'spec_' || psi."specId", psi."itemId", psi.quantity,
       COALESCE(psi.unit, ii.unit), 0, 0, NOW()
FROM "production_spec_items" psi
JOIN "inventory_items" ii ON ii.id = psi."itemId"
WHERE EXISTS (SELECT 1 FROM "recipes" r WHERE r.id = 'spec_' || psi."specId")
ON CONFLICT (id) DO NOTHING;

-- ── 3 · point runs at their recipe, and snapshot its name ───────────────────

UPDATE "production_orders" po
SET "recipeId" = 'spec_' || po."specId",
    "recipeName" = ps.name
FROM "production_specs" ps
WHERE ps.id = po."specId" AND po."recipeId" IS NULL;

-- ── 4 · remove the batch multiplier ─────────────────────────────────────────
--
-- `plannedQty` and `actualQty` counted BATCHES; they now count output units,
-- which is what the owner was asked for and what `unit` always claimed they
-- were. Restated in place rather than added as a second column: two columns
-- would mean every reader has to know which era a row is from, which is the
-- duality this whole change exists to delete.
--
-- Verifiable afterwards, because produced quantity was already actualQty ×
-- outputQty and is stored on production_outputs:
--
--   every COMPLETED run has actualQty = SUM(production_outputs.quantity)

UPDATE "production_orders" po
SET "plannedQty" = po."plannedQty" * ps."outputQty",
    "actualQty"  = po."actualQty"  * ps."outputQty",
    "variance"   = (COALESCE(po."actualQty", po."plannedQty") - po."plannedQty")
                   * ps."outputQty"
FROM "production_specs" ps
WHERE ps.id = po."specId";

-- Runs whose spec was already SET NULL have no recoverable factor. Rebase the
-- finished ones from what they actually produced and say so; cancel the open
-- ones, which could never have completed anyway (completeProduction refuses a
-- run with no recipe).
UPDATE "production_orders" po
SET "actualQty" = o.produced,
    "plannedQty" = o.produced,
    "variance" = 0,
    "varianceNote" = COALESCE(po."varianceNote" || ' · ', '')
      || 'Quantities restated in output units when batch sizes were removed.'
FROM (
  SELECT "orderId", SUM(quantity) AS produced
    FROM "production_outputs" GROUP BY "orderId"
) o
WHERE o."orderId" = po.id
  AND po."specId" IS NULL
  AND po.status IN ('COMPLETED', 'PARTIALLY_COMPLETED');

UPDATE "production_orders"
SET status = 'CANCELLED'
WHERE "specId" IS NULL
  AND status IN ('DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS');

-- ── 5 · constraints ─────────────────────────────────────────────────────────

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_recipeId_fkey"
  FOREIGN KEY ("recipeId") REFERENCES "recipes"(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "production_orders_recipeId_idx"
  ON "production_orders"("recipeId");

-- Created AFTER the backfill on purpose: a backfill that produced two active
-- recipes for one owner fails the migration loudly here instead of silently
-- handing the resolver an arbitrary winner.
CREATE UNIQUE INDEX "recipes_active_produces_key"
  ON "recipes"("restaurantId", "producesItemId")
  WHERE "isActive" AND "producesItemId" IS NOT NULL AND "archivedAt" IS NULL;

CREATE UNIQUE INDEX "recipes_active_food_key"
  ON "recipes"("restaurantId", "foodId")
  WHERE "isActive" AND "foodId" IS NOT NULL AND "archivedAt" IS NULL;
