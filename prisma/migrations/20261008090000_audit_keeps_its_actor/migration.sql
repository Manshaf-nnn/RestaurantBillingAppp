-- ── The append-only tables stop contradicting their own foreign keys ─────────
--
-- WHY
--
-- `20260917093000_append_only_guards` froze three tables with BEFORE UPDATE
-- triggers: audit_logs and refunds outright, stock_movements on its ledger
-- facts only. That migration reasoned carefully about DELETE and deliberately
-- left it unblocked, so that removing a tenant on request stays possible.
--
-- What it did not account for is that `ON DELETE SET NULL` is not a delete.
-- It is an UPDATE on the referencing row, issued by Postgres on the parent's
-- behalf — and the trigger refuses it, correctly, because it cannot tell that
-- update from any other. Three foreign keys were declared that way, and none
-- of them could ever fire:
--
--   DELETE FROM users    WHERE id = <anyone who has ever been audited>
--   DELETE FROM branches WHERE id = <any site with audit history>
--   DELETE FROM users    WHERE id = <anyone who has issued a refund>
--   → ERROR: audit_logs is append-only: a log that can be edited is a diary…
--
-- All three are reproducible. In the development database 137 users carry
-- audit rows and 153 audit rows name a branch, and closing a branch is an
-- ordinary thing for a restaurant group to do — so this is not a corner case.
--
-- WHAT THIS CHANGES
--
-- SET NULL becomes RESTRICT on all three. That is the same refusal the
-- database was already making, said honestly: a foreign-key violation naming
-- the constraint and the table, instead of a trigger error about diaries that
-- gives the caller nothing to act on.
--
-- RESTRICT is also the correct rule on its own merits. `audit_logs.userId`
-- and `refunds.refundedById` record WHO acted, and blanking them was never
-- the right answer to "this person left" — an audit trail whose actor can be
-- erased by deleting a row is not an audit trail. The history now outlives
-- the account, and removing an account requires dealing with its records
-- deliberately, in order, which is what a tenant purge is for.
--
-- NOT CHANGED: stock_movements. Its trigger is column-scoped and guards
-- quantity, unitCost, balanceAfter, type, itemId and restaurantId. None of
-- its six SET NULL links are in that list, so they already work.
--
-- NOT CHANGED: the relations themselves. Five call sites read
-- `auditLog.user`, including the filter in /dashboard/audit-logs that decides
-- whose actions a branch manager may read. Dropping the foreign key would
-- have meant rewriting that filter as a two-step lookup, and rewriting a
-- security predicate to fix a delete rule is a poor trade.
--
-- SAFETY
--
-- No data is read, rewritten or removed; only the delete rule on three
-- constraints changes. Nothing that succeeds today starts failing: every
-- delete this now refuses was already failing, on the trigger, with a worse
-- message. The append-only triggers are untouched — audit_logs and refunds
-- remain exactly as immutable as before.
--
-- ROLLBACK
--
-- Restore SET NULL on the three constraints (the reverse of each statement
-- below). Doing so reinstates the contradiction: deleting an audited user or
-- a branch with history would begin failing again on the trigger.

ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_userId_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_branchId_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_refundedById_fkey";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refundedById_fkey"
  FOREIGN KEY ("refundedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
