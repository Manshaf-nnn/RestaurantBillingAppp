-- A delivery location under a delivery location.
--
-- The list shipped flat, with a free-text `groupName` to head it. The owner's
-- model is two levels: a main place — "University" — and the places inside it
-- that a guest actually picks. A real parent row gives them that: create the
-- university once, add hostels under it, and the guest's picker groups by it
-- without anybody retyping a heading on every row.
--
-- Additive. `groupName` stays — a column cannot be dropped — and is no longer
-- written; the two rows created under the old shape have no children and read
-- as top-level places, which is what they were.

ALTER TABLE "delivery_locations" ADD COLUMN IF NOT EXISTS "parentId" TEXT;

CREATE INDEX IF NOT EXISTS "delivery_locations_parentId_idx"
  ON "delivery_locations" ("parentId");

-- Cascade: retiring is the normal path, but if a main place IS deleted its
-- sub-places have no meaning on their own.
DO $$
BEGIN
  ALTER TABLE "delivery_locations"
    ADD CONSTRAINT "delivery_locations_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "delivery_locations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
