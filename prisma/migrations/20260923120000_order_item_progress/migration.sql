-- Item-level kitchen progress by quantity (abc.md §6).
--
-- A line keeps its one `status` — everything downstream (void, split, merge,
-- depletion, the guest edit) reads it — and gains two counters that say how
-- many of its `quantity` have been prepared and how many of those served.
-- The live floor then reads Ordered / Prepared / Served / Remaining by
-- quantity, with Remaining = Ordered − Prepared − Served by construction and
-- Served never counted as Prepared.
--
-- Additive: defaulted columns, a backfill that agrees with today's statuses,
-- and a CHECK on data the backfill has just made consistent.
ALTER TABLE "order_items"
  ADD COLUMN "preparedQty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "servedQty"   INTEGER NOT NULL DEFAULT 0;

UPDATE "order_items" SET "preparedQty" = "quantity"
 WHERE "status" = 'READY';

UPDATE "order_items" SET "preparedQty" = "quantity", "servedQty" = "quantity"
 WHERE "status" = 'SERVED';

-- served ≤ prepared ≤ quantity, and nothing negative.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_progress_check"
  CHECK ("servedQty" >= 0 AND "servedQty" <= "preparedQty" AND "preparedQty" <= "quantity");
