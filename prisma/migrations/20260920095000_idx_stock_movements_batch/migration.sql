-- bugfix.md D11 — batch traceability reads every movement of a batch, and
-- nothing indexed batchId. One statement, alone, for the same reason as the
-- previous migration.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "stock_movements_batchId_idx"
  ON "stock_movements"("batchId");
