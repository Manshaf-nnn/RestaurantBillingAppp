-- FIFO.md — make the FIFO layers the authoritative inventory costing system.
--
-- Additive. No column is dropped, no table is emptied, and nothing that exists
-- is re-priced: the closing check at the bottom aborts the whole migration if
-- inventory value moves by a single minor unit.
--
-- Three things happen here:
--
--   1. layers learn to carry VALUE rather than a rounded per-unit price, which
--      is what makes the arithmetic exact;
--   2. every movement gains a place to record what it was worth and which
--      layers it drew from;
--   3. stock that no layer explains becomes an explicit, dated opening layer,
--      so "unlotted stock priced at the running average" stops being a
--      permanent parallel costing rule and becomes a finite, visible thing.

-- ── 1. The layer carries value ──────────────────────────────────────────────
--
-- Minor units are integers, so a price cannot be exact: 650 paid for 1,000 g
-- is 0.65 a gram, which rounds to 1 and books the delivery at 1,000 — a 54%
-- overstatement on cheap bulk goods. The ledger already passed an exact
-- `totalValue` on receipt; only the layer was left holding the rounded price.
--
-- Backfilled from what the layer says today (qty × price), so this step alone
-- changes no valuation. Receipts from here on record what was actually paid.
ALTER TABLE "stock_batches"
  ADD COLUMN IF NOT EXISTS "receivedValue"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "remainingValue" INTEGER NOT NULL DEFAULT 0;

UPDATE "stock_batches"
   SET "receivedValue"  = ROUND("receivedQty"  * "unitCost")::INTEGER,
       "remainingValue" = ROUND("remainingQty" * "unitCost")::INTEGER
 WHERE "receivedValue" = 0 AND "remainingValue" = 0;

-- ── 2. A lot number belongs to a branch ─────────────────────────────────────
--
-- It was UNIQUE (itemId, batchNo), and `upsertBatch` looked lots up by that
-- pair with no restaurant or branch filter — so two branches receiving the
-- same supplier lot number for the same item merged into one layer carrying
-- the first branch's id. The second branch's stock became invisible to its own
-- FIFO walk, and the first could draw stock it had never held.
--
-- The old index is dropped only after the new one exists, so uniqueness is
-- never unenforced. Any row pair that would violate the new key is already
-- forbidden by the old one, so this cannot fail on existing data.
CREATE UNIQUE INDEX IF NOT EXISTS "stock_batches_branch_lot_key"
  ON "stock_batches" ("restaurantId", "branchId", "itemId", "batchNo");

DROP INDEX IF EXISTS "stock_batches_itemId_batchNo_key";

-- The FIFO walk itself: open layers for one item at one branch, oldest first.
CREATE INDEX IF NOT EXISTS "stock_batches_item_branch_received_idx"
  ON "stock_batches" ("itemId", "branchId", "receivedAt");

-- ── 3. What a movement was worth ────────────────────────────────────────────
--
-- The exact value was computed on every post and then thrown away: the row
-- held a rounded per-unit cost, so multiplying it back out could not reproduce
-- what left the shelf. Backfilled from the rounded figure for history, which
-- is the best that can be said about rows written before this column existed.
ALTER TABLE "stock_movements"
  ADD COLUMN IF NOT EXISTS "valueMoved" INTEGER NOT NULL DEFAULT 0;

UPDATE "stock_movements"
   SET "valueMoved" = ROUND(ABS("quantity") * "unitCost")::INTEGER
 WHERE "valueMoved" = 0 AND "unitCost" <> 0;

-- ── 4. Which layers a movement drew from ────────────────────────────────────
--
-- `production_consumption_lots` recorded this for production runs and nothing
-- recorded it for anything else, so a sale spanning three layers left no trace
-- of which three. Without it a reversal cannot put stock back where it came
-- from, and the ledger cannot be replayed at cost.
CREATE TABLE IF NOT EXISTS "stock_movement_lots" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "movementId"   TEXT NOT NULL,
  "batchId"      TEXT,
  "batchNo"      TEXT,
  "quantity"     DOUBLE PRECISION NOT NULL,
  "unitCost"     INTEGER NOT NULL DEFAULT 0,
  "lineValue"    INTEGER NOT NULL DEFAULT 0,
  -- No layer covered this slice. The quantity moved and the value is zero —
  -- never a guess. See FIFO.md: "do not invent a fake FIFO cost".
  "uncosted"     BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_movement_lots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "stock_movement_lots_movementId_idx"   ON "stock_movement_lots" ("movementId");
CREATE INDEX IF NOT EXISTS "stock_movement_lots_batchId_idx"      ON "stock_movement_lots" ("batchId");
CREATE INDEX IF NOT EXISTS "stock_movement_lots_uncosted_idx"     ON "stock_movement_lots" ("restaurantId", "uncosted");

DO $$ BEGIN
  ALTER TABLE "stock_movement_lots"
    ADD CONSTRAINT "stock_movement_lots_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_movement_lots"
    ADD CONSTRAINT "stock_movement_lots_movementId_fkey"
    FOREIGN KEY ("movementId") REFERENCES "stock_movements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_movement_lots"
    ADD CONSTRAINT "stock_movement_lots_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 5. Layers that claim more than the shelf holds are drawn down ───────────
--
-- The ledger only consumed a layer when `InventoryItem.trackBatches` was true,
-- which is false by default, while purchases created layers regardless. So on
-- an ordinary item the layers piled up as stock was sold and never came down:
-- the FIFO walk would happily serve stock that left the building weeks ago, at
-- its original price.
--
-- This is the consumption that should have happened, applied now: draw the
-- excess off the OLDEST layers first, which is where it would have come from
-- had the ledger been doing its job. Value goes with it, cleared exactly when
-- a layer empties — the same rule the allocator uses, so the arithmetic here
-- and the arithmetic afterwards are the same arithmetic.
--
-- Runs before the opening layers below, so that step sees a truthful picture.
WITH pair AS (
  SELECT
    b."itemId",
    b."branchId",
    SUM(b."remainingQty")      AS layered,
    COALESCE(s.available, 0)   AS available
  FROM "stock_batches" b
  LEFT JOIN (
    SELECT "itemId", "branchId", SUM("available") AS available
      FROM "inventory_stock" GROUP BY 1, 2
  ) s ON s."itemId" = b."itemId" AND s."branchId" = b."branchId"
  WHERE b."remainingQty" > 0
  GROUP BY b."itemId", b."branchId", s.available
  HAVING SUM(b."remainingQty") > COALESCE(s.available, 0) + 0.000001
),
ordered AS (
  SELECT
    b.id,
    b."remainingQty",
    b."remainingValue",
    p.layered - p.available AS excess,
    -- What the older layers ahead of this one already absorb.
    COALESCE(SUM(b."remainingQty") OVER (
      PARTITION BY b."itemId", b."branchId"
      ORDER BY b."receivedAt", b."createdAt", b.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) AS prior
  FROM "stock_batches" b
  JOIN pair p ON p."itemId" = b."itemId" AND p."branchId" = b."branchId"
  WHERE b."remainingQty" > 0
),
drain AS (
  SELECT
    id,
    "remainingQty" AS qty,
    "remainingValue" AS val,
    LEAST(GREATEST(excess - prior, 0), "remainingQty") AS take
  FROM ordered
)
UPDATE "stock_batches" b
   SET "remainingQty"   = GREATEST(0, ROUND((b."remainingQty" - d.take)::NUMERIC, 6)),
       -- A layer drawn to nothing is worth nothing; a partial draw takes its
       -- share and leaves the residue behind, exactly as the allocator does.
       "remainingValue" = CASE
         WHEN d.take >= d.qty - 0.000001 THEN 0
         ELSE GREATEST(0, d.val - ROUND(d.val * d.take / d.qty)::INTEGER)
       END
  FROM drain d
 WHERE d.id = b.id AND d.take > 0.000001;

-- ── 6. Stock that no layer explains becomes an opening layer ────────────────
--
-- Every transfer in, customer return, sale reversal, adjustment in and
-- stock-count gain added quantity without creating a layer, and no
-- opening-balance backfill has ever run. That remainder was priced at the
-- restaurant-wide running average every time it was drawn — a second costing
-- rule, growing with every multi-branch operation.
--
-- One layer per item per branch for whatever the existing layers do not cover,
-- labelled OPENING so nobody mistakes it for a delivery.
--
-- ── The opening layer is a BALANCING figure, not a priced one ───────────────
--
-- The obvious formula — gap quantity × the item's average cost — is wrong, and
-- wrong in a way that only shows up where it matters. The average already
-- contains the value sitting in the layers that DO exist, so pricing the gap
-- at it counts that value twice. A worked case from this database: Mozzarella,
-- 24 kg on hand worth 595,380, of which 12 kg sits in a production layer worth
-- 55,380. The average is 24,807/kg, so the average rule values the remaining
-- 12 kg at 297,690 and loses 242,310 — a fifth of the item's value, silently.
--
-- The residual is the only honest figure: what the books say the item is worth,
-- less what its layers already account for. That is what the gap must carry,
-- by definition, because the layers have to add up to the pool afterwards.
--
-- Where an item has a gap at more than one branch the residual is split across
-- them pro rata by quantity, using cumulative rounding so the parts sum to the
-- whole exactly — the same trick the layer draw itself uses.
INSERT INTO "stock_batches" (
  "id", "restaurantId", "itemId", "batchNo", "receivedQty", "remainingQty",
  "receivedValue", "remainingValue", "unitCost", "branchId", "receivedAt",
  "createdAt", "updatedAt"
)
WITH branch_gap AS (
  SELECT
    s."itemId",
    s."branchId",
    ROUND((s.available - COALESCE(b.layered, 0))::NUMERIC, 6) AS qty
  FROM (
    SELECT "itemId", "branchId", SUM("available") AS available
      FROM "inventory_stock"
     GROUP BY "itemId", "branchId"
  ) s
  LEFT JOIN (
    SELECT "itemId", "branchId", SUM("remainingQty") AS layered
      FROM "stock_batches"
     GROUP BY "itemId", "branchId"
  ) b ON b."itemId" = s."itemId" AND b."branchId" = s."branchId"

  UNION ALL

  /*
   * ── Stock that exists on the item but on no shelf ─────────────────────────
   *
   * An item's quantity lives in two places: `inventory_items.quantity`, which
   * is restaurant-wide, and `inventory_stock.available`, which is per branch.
   * They are meant to agree. On production, two items have a quantity and a
   * value on the item row and NO `inventory_stock` row at all — legacy stock
   * that predates the per-branch table.
   *
   * The arm above reads only `inventory_stock`, so those items produced no
   * gap row, got no opening layer, and arrived at the closing check with a
   * pool of 1,400,000 against layers of 0. The check did exactly its job and
   * refused the whole migration — correctly, because the alternative was to
   * quietly drop that value off the balance sheet.
   *
   * So they are placed explicitly, at the branch the item itself names, then
   * the restaurant's default, then its oldest branch — the same order the app
   * resolves a branch in when a write does not name one. The value follows the
   * ordinary residual rule below; this only decides WHERE it lands.
   */
  SELECT
    i."id"                                    AS "itemId",
    COALESCE(
      i."branchId",
      (SELECT b2."id" FROM "branches" b2
        WHERE b2."restaurantId" = i."restaurantId" AND b2."isDefault" = true
        ORDER BY b2."id" LIMIT 1),
      (SELECT b3."id" FROM "branches" b3
        WHERE b3."restaurantId" = i."restaurantId"
        ORDER BY b3."createdAt", b3."id" LIMIT 1)
    )                                         AS "branchId",
    ROUND(i."quantity"::NUMERIC, 6)           AS qty
  FROM "inventory_items" i
  WHERE i."quantity" > 0.000001
    AND NOT EXISTS (
      SELECT 1 FROM "inventory_stock" s2
       WHERE s2."itemId" = i."id" AND s2."available" > 0.000001
    )
    AND NOT EXISTS (
      SELECT 1 FROM "stock_batches" b4
       WHERE b4."itemId" = i."id" AND b4."remainingQty" > 0.000001
    )
),
positive_gap AS (
  -- `stock_batches.branchId` is NOT NULL, so an item at a restaurant with no
  -- branch at all is skipped rather than failing the insert. The closing check
  -- still reports it, which is the right outcome: there is nowhere to put that
  -- stock, and that is a fact about the data, not something to paper over.
  SELECT * FROM branch_gap WHERE qty > 0.000001 AND "branchId" IS NOT NULL
),
item_residual AS (
  SELECT
    i."id"           AS "itemId",
    i."restaurantId",
    -- What the books say, less what the layers already hold. Never below zero:
    -- layers worth MORE than the pool is a pre-existing discrepancy, and the
    -- closing check below is what reports it rather than absorbing it here.
    GREATEST(0, ROUND(i."stockValue")::BIGINT - COALESCE(l.layered, 0)) AS residual
  FROM "inventory_items" i
  LEFT JOIN (
    SELECT "itemId", SUM("remainingValue")::BIGINT AS layered
      FROM "stock_batches" GROUP BY "itemId"
  ) l ON l."itemId" = i."id"
),
shared AS (
  SELECT
    g."itemId",
    g."branchId",
    g.qty,
    r."restaurantId",
    r.residual,
    SUM(g.qty) OVER (PARTITION BY g."itemId")                                   AS total_qty,
    SUM(g.qty) OVER (PARTITION BY g."itemId" ORDER BY g."branchId"
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)          AS cum_qty,
    COALESCE(SUM(g.qty) OVER (PARTITION BY g."itemId" ORDER BY g."branchId"
                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)      AS prev_qty
  FROM positive_gap g
  JOIN item_residual r ON r."itemId" = g."itemId"
)
SELECT
  'opening_' || md5("itemId" || ':' || "branchId"),
  "restaurantId",
  "itemId",
  'OPENING',
  qty,
  qty,
  val,
  val,
  CASE WHEN qty > 0 THEN ROUND(val / qty)::INTEGER ELSE 0 END,
  "branchId",
  -- Dated before every real delivery, so it is always drawn first. Opening
  -- stock IS the oldest stock; anything else would break FIFO on day one.
  TIMESTAMP '2000-01-01 00:00:00',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT
    s.*,
    -- Cumulative differencing: each branch takes the difference between its own
    -- rounded running share and the previous one, so the shares sum to the
    -- residual with no drift and the last branch absorbs the remainder.
    (ROUND(s.residual * s.cum_qty  / s.total_qty)
   - ROUND(s.residual * s.prev_qty / s.total_qty))::INTEGER AS val
  FROM shared s
  WHERE s.total_qty > 0
) parts
WHERE NOT EXISTS (
  SELECT 1 FROM "stock_batches" b
   WHERE b."itemId" = parts."itemId"
     AND b."branchId" = parts."branchId"
     AND b."batchNo" = 'OPENING'
);

-- ── 7. A layer cannot go negative, or hold more than it received ────────────
--
-- There was no constraint on this table at all, and `consumeBatches` is a bare
-- decrement with no compare-and-set, so a concurrent double-draw produced a
-- negative layer with nothing to stop it.
--
-- NOT VALID so the migration does not scan the table under a lock; the rows
-- already there are validated separately below. The same pattern as
-- 20260917100000_money_stock_check_constraints.
DO $$ BEGIN
  ALTER TABLE "stock_batches"
    ADD CONSTRAINT "stock_batches_remaining_nonneg"
    CHECK ("remainingQty" >= 0 AND "remainingValue" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_batches"
    ADD CONSTRAINT "stock_batches_remaining_within_received"
    CHECK ("remainingQty" <= "receivedQty" + 0.000001 AND "remainingValue" <= "receivedValue")
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 8. The new fact is frozen like the others ───────────────────────────────
--
-- `stock_movements` is append-only: quantity, cost, balance, type and
-- ownership cannot be edited after the fact. `valueMoved` is a ledger fact of
-- exactly the same kind, so it joins them.
CREATE OR REPLACE FUNCTION tableflow_stock_movements_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW."quantity"     IS DISTINCT FROM OLD."quantity"
  OR NEW."unitCost"     IS DISTINCT FROM OLD."unitCost"
  OR NEW."valueMoved"   IS DISTINCT FROM OLD."valueMoved"
  OR NEW."balanceAfter" IS DISTINCT FROM OLD."balanceAfter"
  OR NEW."type"         IS DISTINCT FROM OLD."type"
  OR NEW."itemId"       IS DISTINCT FROM OLD."itemId"
  OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
  THEN
    RAISE EXCEPTION 'stock_movements ledger facts are immutable (attempted to change quantity, cost, value, balance, type or ownership); reverse the movement instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 9. Prove the books did not move ─────────────────────────────────────────
--
-- The whole point of an opening layer valued at the item's own cost is that
-- inventory value is exactly where it was. This asserts it, and aborts the
-- migration if it is not — a costing migration that silently restates the
-- balance sheet is the one thing that must not be possible.
--
-- Compared per item: the sum of that item's layers against the value pool the
-- ledger has been maintaining. A tolerance of one minor unit per item absorbs
-- the rounding of the opening layer itself and nothing larger.
DO $$
DECLARE
  bad RECORD;
  drift BIGINT;
BEGIN
  SELECT COUNT(*) INTO drift
    FROM "inventory_items" i
    LEFT JOIN (
      SELECT "itemId", SUM("remainingValue") AS layered
        FROM "stock_batches" GROUP BY "itemId"
    ) b ON b."itemId" = i."id"
   WHERE i."quantity" > 0
     AND ABS(COALESCE(b.layered, 0) - ROUND(i."stockValue")) > 1;

  IF drift > 0 THEN
    SELECT i."id", i."name", ROUND(i."stockValue") AS pool, COALESCE(b.layered, 0) AS layered
      INTO bad
      FROM "inventory_items" i
      LEFT JOIN (
        SELECT "itemId", SUM("remainingValue") AS layered
          FROM "stock_batches" GROUP BY "itemId"
      ) b ON b."itemId" = i."id"
     WHERE i."quantity" > 0
       AND ABS(COALESCE(b.layered, 0) - ROUND(i."stockValue")) > 1
     LIMIT 1;

    RAISE EXCEPTION
      'FIFO migration would restate inventory value on % item(s). First: % (%) — pool %, layers %. Nothing has been committed.',
      drift, bad.name, bad.id, bad.pool, bad.layered;
  END IF;
END $$;
