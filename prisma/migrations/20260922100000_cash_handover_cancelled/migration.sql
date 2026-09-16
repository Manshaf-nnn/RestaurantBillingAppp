-- recorrection.md §2 — a cash handover can be withdrawn before anyone accepts
-- it. The code told people to "cancel that first" and offered no way to; a
-- declined handover stranded the counted cash in no session.
--
-- In its own migration because `ALTER TYPE … ADD VALUE` and any statement
-- that uses the new value cannot share a transaction.
ALTER TYPE "CashHandoverStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
