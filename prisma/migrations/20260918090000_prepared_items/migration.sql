-- Prepared items (redesignkitchenjob.md).
--
-- Production becomes a one-step "Make Item": a prepared item is an ordinary
-- inventory item flagged `isPrepared`, a run records which item it produced and
-- the request key that makes completing it idempotent, and production waste is
-- linked from the wastage record it creates. Everything here is additive; the
-- two UPDATEs backfill from rows that already exist.

-- ── inventory_items ─────────────────────────────────────────────────────────
ALTER TABLE "inventory_items" ADD COLUMN "isPrepared" BOOLEAN NOT NULL DEFAULT false;

-- Anything a production run has ever produced, or a prep recipe produces, is
-- already a prepared item — say so.
UPDATE "inventory_items" SET "isPrepared" = true
 WHERE id IN (SELECT DISTINCT "itemId" FROM "production_outputs")
    OR id IN (SELECT "producesItemId" FROM "recipes" WHERE "producesItemId" IS NOT NULL);

-- ── production_orders ───────────────────────────────────────────────────────
ALTER TABLE "production_orders" ADD COLUMN "outputItemId" TEXT;
ALTER TABLE "production_orders" ADD COLUMN "clientRequestId" TEXT;

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_outputItemId_fkey"
  FOREIGN KEY ("outputItemId") REFERENCES "inventory_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Completed runs already know what they produced through production_outputs.
UPDATE "production_orders" o
   SET "outputItemId" = po."itemId"
  FROM "production_outputs" po
 WHERE po."orderId" = o.id AND o."outputItemId" IS NULL;

-- Unique on a column added above: no existing row can collide (NULLs are distinct).
CREATE UNIQUE INDEX "production_orders_restaurantId_clientRequestId_key"
  ON "production_orders"("restaurantId", "clientRequestId");

CREATE INDEX "production_orders_restaurantId_outputItemId_completedAt_idx"
  ON "production_orders"("restaurantId", "outputItemId", "completedAt");

-- The planning stages are gone. A job that was only ever planned never moved
-- stock, so cancelling it changes no balance; the note says why.
UPDATE "production_orders"
   SET status = 'CANCELLED',
       notes = COALESCE(notes || ' ', '') || '[cancelled 2026-09-05: planning stage removed]'
 WHERE status IN ('DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS');

-- ── wastage_records ─────────────────────────────────────────────────────────
ALTER TABLE "wastage_records" ADD COLUMN "productionOrderId" TEXT;

ALTER TABLE "wastage_records"
  ADD CONSTRAINT "wastage_records_productionOrderId_fkey"
  FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "wastage_records_productionOrderId_idx" ON "wastage_records"("productionOrderId");
