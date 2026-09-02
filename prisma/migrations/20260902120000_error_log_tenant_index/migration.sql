-- /api/health/errors now scopes by tenant; give the predicate an index.
CREATE INDEX IF NOT EXISTS "error_logs_restaurantId_createdAt_idx"
  ON "error_logs"("restaurantId", "createdAt");
