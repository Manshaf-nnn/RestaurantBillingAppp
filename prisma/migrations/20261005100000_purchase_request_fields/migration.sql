-- What a purchase request carries that an order did not.
--
-- `priority` is how urgently the site needs it — shown on the request and in
-- the approver's queue, and changing nothing about how the order is processed.
-- NORMAL for every row that exists, which is the honest default: nothing was
-- ever marked otherwise.
--
-- `submittedAt` is when it was last sent for approval; `decisionNote` is why
-- an approver rejected it or sent it back, cleared on resubmission so the next
-- reader sees only the ruling that stands. `cancelReason` is left alone: a
-- cancellation is the requester's own act and keeps its own column.
--
-- `closedAt` marks the end of an order that is done with.
--
-- `goods_receipts.invoiceDate` is the date on the supplier's invoice, beside
-- the number the column next to it has always held. The receipt's own
-- `receivedAt` is when the goods came in; the two differ whenever the
-- paperwork arrives later than the van.
--
-- Additive throughout: one new enum, five nullable-or-defaulted columns. No
-- row is rewritten and nothing is dropped.

DO $$ BEGIN
  CREATE TYPE "PurchasePriority" AS ENUM ('LOW', 'NORMAL', 'URGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "purchases"
  ADD COLUMN IF NOT EXISTS "priority" "PurchasePriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "decisionNote" TEXT,
  ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);

ALTER TABLE "goods_receipts"
  ADD COLUMN IF NOT EXISTS "invoiceDate" TIMESTAMP(3);
