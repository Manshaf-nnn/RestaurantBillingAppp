-- A booking belongs to a location.
--
-- `Reservation` carried only `restaurantId`, so the diary was the whole
-- group's: a Kandy manager read Colombo's bookings, and — worse — the table
-- picker on that screen listed every branch's tables with nothing to tell them
-- apart. Table numbers restart per branch by design, so it showed several
-- "Table 4" rows and let a booking be seated at another site's table.
--
-- Nullable, and it stays nullable. Backfilling from the table gets every
-- booking that named one; a booking taken over the phone with no table chosen
-- yet has no honest branch to infer, and inventing one would be worse than
-- leaving it unset. New bookings always carry one — the form now asks.

ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "branchId" TEXT;

CREATE INDEX IF NOT EXISTS "reservations_restaurantId_branchId_reservedAt_idx"
  ON "reservations"("restaurantId", "branchId", "reservedAt");

DO $$ BEGIN
  ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The table knows where it is, and a booking that named one is unambiguous.
UPDATE "reservations" r
SET "branchId" = t."branchId"
FROM "restaurant_tables" t
WHERE t."id" = r."tableId" AND r."branchId" IS NULL;

-- A restaurant with exactly one location has no ambiguity either, so the rest
-- of its bookings can be placed safely. Multi-branch restaurants keep their
-- table-less bookings unassigned rather than being guessed at.
UPDATE "reservations" r
SET "branchId" = b."id"
FROM "branches" b
WHERE r."branchId" IS NULL
  AND b."restaurantId" = r."restaurantId"
  AND b."deletedAt" IS NULL
  AND (
    SELECT COUNT(*) FROM "branches" x
    WHERE x."restaurantId" = r."restaurantId" AND x."deletedAt" IS NULL
  ) = 1;
