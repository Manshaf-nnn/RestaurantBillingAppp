-- pro.b.md — Kitchen Production: a separate issue step, FIFO lots, and the
-- fields the production order was missing.
--
-- Additive. No column is dropped, no row is updated, and no table carrying a
-- NOT VALID check is touched.

-- ── §3. What a run makes: a label, not a branch in the logic ────────────────
DO $$ BEGIN
  CREATE TYPE "ProductionType" AS ENUM ('SEMI_FINISHED', 'FINISHED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "production_orders"
  ADD COLUMN IF NOT EXISTS "productionType" "ProductionType" NOT NULL DEFAULT 'SEMI_FINISHED',
  ADD COLUMN IF NOT EXISTS "requiredDate"   TIMESTAMP(3),
  -- §6. Output lost while making it. Never moves stock; see the schema comment.
  ADD COLUMN IF NOT EXISTS "wastageQty"     DOUBLE PRECISION;

-- ── §4, §5, §9. Which lots each consumed ingredient came from ───────────────
--
-- 12 kg of chicken drawn as 5 kg @ 12.00 and 7 kg @ 12.80 is two rows. This is
-- the trace from a production batch back to the deliveries it was made from,
-- and the reason its cost is the cost of those deliveries rather than an
-- average of the shelf. `batchId` is null for the one layer with no lot —
-- stock received before every receipt created one — valued at the running
-- average, and the row says so.
CREATE TABLE IF NOT EXISTS "production_consumption_lots" (
  "id"            TEXT NOT NULL,
  "consumptionId" TEXT NOT NULL,
  "batchId"       TEXT,
  "batchNo"       TEXT,
  "quantity"      DOUBLE PRECISION NOT NULL,
  "unitCost"      INTEGER NOT NULL,
  "lineCost"      INTEGER NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_consumption_lots_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "production_consumption_lots"
    ADD CONSTRAINT "production_consumption_lots_consumptionId_fkey"
    FOREIGN KEY ("consumptionId") REFERENCES "production_consumption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "production_consumption_lots"
    ADD CONSTRAINT "production_consumption_lots_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "production_consumption_lots_consumptionId_idx"
  ON "production_consumption_lots"("consumptionId");
CREATE INDEX IF NOT EXISTS "production_consumption_lots_batchId_idx"
  ON "production_consumption_lots"("batchId");
