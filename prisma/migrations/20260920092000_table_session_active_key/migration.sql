-- bugfix.md D4 / D13 — one open sitting per table, and a table's history
-- survives the table.
--
-- Two guests scanning one table's code in the same second both found "no
-- open sitting" and both opened one, because the check and the insert were
-- two statements with nothing between them. The fix is the idiom cash drawers
-- already use: a nullable key that holds the table's id while the sitting is
-- OPEN and NULL once it closes, under a unique index — so the database, not
-- a read, is the arbiter. The backfill keeps the NEWEST open sitting per
-- table as the live one; older duplicates keep NULL and stay exactly as they
-- are, because closing them here would invent a fact nobody recorded.
--
-- Deleting a table used to cascade through every sitting and every service
-- request it ever had. RESTRICT: the screen offers "mark inactive" instead.

ALTER TABLE "table_sessions" ADD COLUMN "activeTableKey" TEXT;

UPDATE "table_sessions" s
   SET "activeTableKey" = s."tableId"
  FROM (
    SELECT id, row_number() OVER (PARTITION BY "tableId" ORDER BY "openedAt" DESC) AS rn
      FROM "table_sessions"
     WHERE status = 'OPEN'
  ) ranked
 WHERE s.id = ranked.id AND ranked.rn = 1;

CREATE UNIQUE INDEX IF NOT EXISTS "table_sessions_activeTableKey_key"
  ON "table_sessions"("activeTableKey");

DO $$
DECLARE existing text;
BEGIN
  SELECT c.conname INTO existing
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = '"table_sessions"'::regclass AND c.contype = 'f' AND a.attname = 'tableId'
   LIMIT 1;
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "table_sessions" DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "restaurant_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
DECLARE existing text;
BEGIN
  SELECT c.conname INTO existing
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = '"service_requests"'::regclass AND c.contype = 'f' AND a.attname = 'tableId'
   LIMIT 1;
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "service_requests" DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "restaurant_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;
