-- bill.md §1 — which rows a printed bill shows.
--
-- A separate column from `printerConfig` on purpose: that one is the hardware
-- (58mm/80mm) and is written by its own settings form. Two forms writing one
-- JSON column is how one form silently deletes the other's keys.
--
-- Nullable with no default: absent means "the defaults", which are exactly
-- what receipts print today, so this migration changes nobody's paper.
ALTER TABLE "restaurants" ADD COLUMN "receiptConfig" JSONB;
