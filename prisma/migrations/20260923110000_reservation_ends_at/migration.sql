-- abc.md §4 — a booking stores its end as well as its start and duration.
--
-- The end was never written, so the database could not be asked "what is
-- booked on table 4 at eight" and nothing ever asked it: two bookings on one
-- table at one time were accepted without a word. The column is what the
-- overlap check and the Reserved window read. Nullable and backfilled: every
-- existing row gets start + duration, and the app writes it on every save.

ALTER TABLE "reservations" ADD COLUMN "endsAt" TIMESTAMP(3);

UPDATE "reservations"
   SET "endsAt" = "reservedAt" + ("durationMinutes" * INTERVAL '1 minute')
 WHERE "endsAt" IS NULL;

CREATE INDEX "reservations_restaurantId_tableId_reservedAt_idx"
    ON "reservations"("restaurantId", "tableId", "reservedAt");
