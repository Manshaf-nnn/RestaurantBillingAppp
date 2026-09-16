-- A guest, or a colleague on their behalf, calling a waiter (abc.md §7).
--
-- In its own migration: Postgres will not let a transaction use an enum
-- value it added itself, and the next migration backfills against it.
ALTER TYPE "ServiceRequestType" ADD VALUE IF NOT EXISTS 'CALL_WAITER';
