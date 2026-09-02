-- Follow-ups from the adversarial migration review (deploy incident 2026-09-02).

-- 1. Reseed the purchase counter at the TRUE high-water mark. It was seeded
--    with COUNT(*), which undercounts wherever rows were ever deleted — and a
--    second, max-scan generator existed until now, so count and max diverge.
--    GREATEST of both means the next number can never collide.
INSERT INTO "restaurant_counters" ("restaurantId", "key", "value")
SELECT p."restaurantId",
       'purchase',
       GREATEST(
         COUNT(*),
         MAX(COALESCE(NULLIF(substring(p."number" from '^PO-0*([0-9]+)$'), '')::bigint, 0))
       )::int
FROM "purchases" p
GROUP BY p."restaurantId"
ON CONFLICT ("restaurantId", "key")
DO UPDATE SET "value" = GREATEST("restaurant_counters"."value", EXCLUDED."value");

-- 2. Two restaurant-level daily closes could coexist for one date: the
--    three-column unique treats NULL branchIds as distinct rows. A partial
--    unique index closes the NULL case. (Partial indexes are invisible to
--    Prisma's schema diff — same documented precedent as the order
--    idempotency index.)
CREATE UNIQUE INDEX "daily_closes_restaurant_level_key"
  ON "daily_closes"("restaurantId", "businessDate")
  WHERE "branchId" IS NULL;

-- 3. orders.tableSessionId has an ON DELETE SET NULL foreign key and no
--    index, so deleting a table session would seq-scan orders under lock.
CREATE INDEX "orders_tableSessionId_idx" ON "orders"("tableSessionId");

-- 4. The rate-limit sweep deletes by windowStart alone; give it an index so
--    a 1%-of-requests cleanup never seq-scans a table written on every call.
CREATE INDEX "rate_limit_counters_windowStart_idx" ON "rate_limit_counters"("windowStart");
