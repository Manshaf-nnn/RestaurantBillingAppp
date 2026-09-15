-- bugfix.md D10 — eight reconciliation and accounting queries filter payments
-- by paidAt over a date range, and the only index was on createdAt, so every
-- one of them read the tenant's whole payment history to answer "this month".
--
-- One statement, alone in this file, on purpose: CONCURRENTLY cannot run
-- inside a transaction, and a single-statement migration is sent without one.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_restaurantId_status_paidAt_idx"
  ON "payments"("restaurantId", "status", "paidAt");
