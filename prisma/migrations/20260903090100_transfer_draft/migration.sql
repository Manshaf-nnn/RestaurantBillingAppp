-- A transfer you can build before you send it.
--
-- The spec asks for Draft → Requested → … and REQUESTED was the first state a
-- transfer could hold, so a half-finished request was already a live request
-- sitting in somebody's queue.
--
-- In its own migration because `ALTER TYPE … ADD VALUE` and any statement that
-- USES the new value cannot share a transaction. Nothing here uses it; the
-- next migration, and the application, can.

ALTER TYPE "TransferStatus" ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'REQUESTED';
