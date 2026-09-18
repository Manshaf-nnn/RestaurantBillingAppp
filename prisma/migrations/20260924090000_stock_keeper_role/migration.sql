-- stockMa.md — a branch-bound storeman: receives, moves, counts, wastes and
-- makes, at one location, and asks for an adjustment rather than making one.
--
-- In its own migration because `ALTER TYPE … ADD VALUE` and any statement that
-- uses the new value cannot share a transaction.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'STOCK_KEEPER';
