-- What the approver allowed, beside what was asked for.
--
-- A branch asks for 50 kg; the store has 30. Until now the approver's only
-- choices were to approve 50 — reserving stock that is not there and pushing
-- the problem to the person loading the van — or to reject the whole request
-- and make the branch raise it again. Neither is what actually happens in a
-- store room, which is "you can have 30".
--
-- A NEW column rather than an edit to `requestedQty`, for the same reason
-- `sentQty` and `receivedQty` are their own columns: the request records what
-- the branch asked for, and overwriting it destroys the one fact worth having
-- afterwards — that they asked for 50 and got 30. The chain reads
-- asked → allowed → sent → received, each link written once, by the person
-- responsible for it.
--
-- Nullable, and null means "as requested". That is every line approved without
-- an edit and every line that already exists, so the backfill is the absence
-- of one: no row changes meaning, and the reserve/dispatch/cancel paths read
-- `COALESCE(approvedQty, requestedQty)`.

ALTER TABLE "stock_transfer_lines" ADD COLUMN IF NOT EXISTS "approvedQty" DOUBLE PRECISION;

-- Never negative, and never more than was asked for: an approver may cut a
-- request or leave it alone, but "approving" more than a branch requested is
-- not an approval, it is a different request.
DO $$
BEGIN
  ALTER TABLE "stock_transfer_lines"
    ADD CONSTRAINT "stock_transfer_lines_approvedQty_sane"
    CHECK ("approvedQty" IS NULL OR ("approvedQty" >= 0 AND "approvedQty" <= "requestedQty" + 0.000001))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "stock_transfer_lines" VALIDATE CONSTRAINT "stock_transfer_lines_approvedQty_sane";
