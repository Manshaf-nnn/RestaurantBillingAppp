-- correctionA.md §10 — a batch can be started now and finished later, when the
-- cook knows what it actually yielded.
--
-- The plan is stored as JSON rather than as ProductionConsumption rows, and
-- the distinction is the point: a consumption row means those base units have
-- left the shelf. Writing them for a batch that has not been made yet would
-- show a kitchen's stock as spent before anybody had opened a bag, and every
-- report reading the ledger would agree with it.
--
-- Nothing is deducted until Mark Done, which runs the same single atomic
-- transaction the one-step Make Item flow has always used.
--
-- Nullable and additive: null is every run ever made in one step, which is all
-- of them so far.

ALTER TABLE "production_orders" ADD COLUMN "plan" JSONB;
