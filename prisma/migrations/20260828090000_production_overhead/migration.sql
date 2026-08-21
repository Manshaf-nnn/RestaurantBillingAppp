-- Costs beyond ingredients: labour, power, packaging time.
--
-- workflow.md §20 asks for "other applicable production costs"; the run's total
-- was materials only, so every finished item was costed below what it really
-- took to make and any margin derived from it was flattered.
ALTER TABLE "production_orders"
  ADD COLUMN IF NOT EXISTS "overheadCost" INTEGER NOT NULL DEFAULT 0;
