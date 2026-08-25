-- Closing a drawer somebody else left open.
--
-- A cashier goes home without closing. The till still holds their session, the
-- unique index on `activeRegisterKey` does its job, and the next cashier is met
-- with "Somebody else already has this till open" and no way forward. The owner
-- needs to be able to close it — and the record has to stay honest about who
-- did that and whether the money was ever counted.
--
-- `countedCash` and `variance` are already nullable, so an uncounted close
-- needs no column change: NULL there now means "nobody counted", which is a
-- different and more useful statement than a variance of zero. This flag is
-- what distinguishes it from a session simply still in progress.

ALTER TABLE "cash_drawer_sessions"
  ADD COLUMN IF NOT EXISTS "closedOnBehalf" BOOLEAN NOT NULL DEFAULT false;
