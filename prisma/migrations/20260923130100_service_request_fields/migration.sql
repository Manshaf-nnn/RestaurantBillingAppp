-- A waiter call is an event: restaurant + branch + table + who called, then
-- acknowledged by whom and when, then resolved by whom and when (abc.md §7).
--
-- Additive: nullable columns with SET NULL foreign keys, a backfill of the
-- branch from the table, and — after resolving any duplicates that the old
-- three-minute window let through — a PARTIAL unique index that makes "one
-- active call per table and need" a rule the database keeps rather than a
-- race the application tries to win. The predicate is `status <> 'RESOLVED'`:
-- a resolved call never blocks the next one, an open or acknowledged call
-- always does.

ALTER TABLE "service_requests"
  ADD COLUMN "branchId"         TEXT,
  ADD COLUMN "requestedByName"  TEXT,
  ADD COLUMN "createdById"      TEXT,
  ADD COLUMN "acknowledgedAt"   TIMESTAMP(3),
  ADD COLUMN "acknowledgedById" TEXT;

ALTER TABLE "service_requests"
  ADD CONSTRAINT "service_requests_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "service_requests_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "service_requests_acknowledgedById_fkey"
    FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The table knows which building it is in.
UPDATE "service_requests" sr
   SET "branchId" = t."branchId"
  FROM "restaurant_tables" t
 WHERE t.id = sr."tableId"
   AND sr."branchId" IS NULL;

-- A call somebody has already acknowledged was acknowledged by whoever
-- handled it, as far as the old data can say.
UPDATE "service_requests"
   SET "acknowledgedAt" = COALESCE("resolvedAt", "createdAt"),
       "acknowledgedById" = "handledById"
 WHERE "status" IN ('ACKNOWLEDGED', 'RESOLVED')
   AND "acknowledgedAt" IS NULL;

-- Resolve older duplicates first: keep the newest active call per
-- (table, need), close the rest, so the index below finds clean data.
UPDATE "service_requests" sr
   SET "status" = 'RESOLVED',
       "resolvedAt" = COALESCE(sr."resolvedAt", NOW() AT TIME ZONE 'UTC')
 WHERE sr."status" <> 'RESOLVED'
   AND EXISTS (
     SELECT 1 FROM "service_requests" newer
      WHERE newer."tableId" = sr."tableId"
        AND newer."type" = sr."type"
        AND newer."status" <> 'RESOLVED'
        AND (newer."createdAt" > sr."createdAt"
             OR (newer."createdAt" = sr."createdAt" AND newer.id > sr.id))
   );

-- One active call per table and need. Partial: resolved rows are history.
CREATE UNIQUE INDEX "service_requests_one_active_per_table_need"
  ON "service_requests"("tableId", "type")
  WHERE "status" <> 'RESOLVED';

CREATE INDEX "service_requests_restaurantId_branchId_status_createdAt_idx"
  ON "service_requests"("restaurantId", "branchId", "status", "createdAt");

CREATE INDEX "service_requests_createdById_idx" ON "service_requests"("createdById");
CREATE INDEX "service_requests_acknowledgedById_idx" ON "service_requests"("acknowledgedById");
