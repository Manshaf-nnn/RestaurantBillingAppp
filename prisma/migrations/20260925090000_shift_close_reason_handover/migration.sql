-- shifthandover.md §4 — accepting a handover ends the outgoing person's shift,
-- and the shift should say that is why it ended.
--
-- In its own migration because `ALTER TYPE … ADD VALUE` and any statement that
-- uses the new value cannot share a transaction.
ALTER TYPE "ShiftCloseReason" ADD VALUE IF NOT EXISTS 'HANDOVER';
