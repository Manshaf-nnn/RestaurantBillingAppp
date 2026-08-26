-- Attendance: `staff_shifts` finally gets used.
--
-- The table has existed since the branches migration with `clockInAt`,
-- `clockOutAt` and both the indexes an attendance report needs, and no code has
-- ever read or written it. This is what it needs to become a record somebody
-- could be paid from.
--
-- Everything here is written to be correct on a table that is NOT empty, even
-- though it is empty in production. A developer database that has been poked at
-- by hand is exactly where an assumption like that goes wrong, and an attendance
-- migration that silently drops rows is the worst possible way to find out.

DO $$ BEGIN
  CREATE TYPE "ShiftSource" AS ENUM ('LOGIN', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ShiftCloseReason" AS ENUM
    ('SIGN_OUT', 'AUTO_IDLE', 'AUTO_CAP', 'BRANCH_CHANGE', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "staff_shifts"
  ADD COLUMN IF NOT EXISTS "lastActionAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "businessDate"       DATE,
  ADD COLUMN IF NOT EXISTS "activeShiftKey"     TEXT,
  ADD COLUMN IF NOT EXISTS "source"             "ShiftSource" NOT NULL DEFAULT 'LOGIN',
  ADD COLUMN IF NOT EXISTS "closedBy"           "ShiftCloseReason",
  ADD COLUMN IF NOT EXISTS "adjustedClockInAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adjustedClockOutAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adjustedById"       TEXT,
  ADD COLUMN IF NOT EXISTS "adjustedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adjustReason"       TEXT;

-- A shift with no branch would show on no branch's tab, so `branchId` becomes
-- required. Resolve it the same way the application would: the person's own
-- location first, then the restaurant's default.
UPDATE "staff_shifts" s
SET "branchId" = COALESCE(
      s."branchId",
      (SELECT u."branchId" FROM "users" u WHERE u.id = s."userId"),
      (SELECT b.id FROM "branches" b
        WHERE b."restaurantId" = s."restaurantId" AND b."isDefault" = true
        LIMIT 1))
WHERE s."branchId" IS NULL;

-- The business day, in UTC, matching what the application stamps for a
-- restaurant that has not set a timezone. Existing rows are a developer
-- artefact; new ones are stamped in the restaurant's own zone.
UPDATE "staff_shifts"
SET "businessDate" = ("clockInAt" AT TIME ZONE 'UTC')::date
WHERE "businessDate" IS NULL;

-- Refuse rather than discard. If a row cannot be given a branch the honest
-- outcome is a failed deploy somebody has to look at, not attendance quietly
-- deleted to make a constraint fit.
DO $$
DECLARE orphans INT;
BEGIN
  SELECT COUNT(*) INTO orphans FROM "staff_shifts" WHERE "branchId" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'staff_shifts: % row(s) have no resolvable branch. Give the restaurant a default branch, or set staff_shifts."branchId" by hand, then run this again.',
      orphans;
  END IF;
END $$;

ALTER TABLE "staff_shifts" ALTER COLUMN "branchId"     SET NOT NULL;
ALTER TABLE "staff_shifts" ALTER COLUMN "businessDate" SET NOT NULL;

-- One open shift per person, enforced by the database rather than by a check
-- somebody can forget. `activeShiftKey` holds the user id while the shift is
-- open and NULL once it closes; Postgres does not collide NULLs in a unique
-- index, so any number of closed shifts coexist. Same idiom as
-- `cash_drawer_sessions.activeCashierKey`, and a plain unique rather than a
-- partial index because Prisma cannot see a partial one and reports it as drift
-- on every diff.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_shifts_activeShiftKey_key"
  ON "staff_shifts"("activeShiftKey");

CREATE INDEX IF NOT EXISTS "staff_shifts_restaurantId_branchId_businessDate_idx"
  ON "staff_shifts"("restaurantId", "branchId", "businessDate");

CREATE INDEX IF NOT EXISTS "staff_shifts_userId_businessDate_idx"
  ON "staff_shifts"("userId", "businessDate");

DO $$ BEGIN
  ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_adjustedById_fkey"
    FOREIGN KEY ("adjustedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `branchId` was nullable, so its foreign key was ON DELETE SET NULL. It cannot
-- be now: a shift must keep pointing at the location it happened in. RESTRICT
-- matches every other operational table — a location holding history is not
-- deleted, it is soft-deleted with `deletedAt`.
DO $$ BEGIN
  ALTER TABLE "staff_shifts" DROP CONSTRAINT IF EXISTS "staff_shifts_branchId_fkey";
  ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The staff activity feed asks "everything this person did between these two
-- timestamps". Every existing index on the audit trail leads with
-- `restaurantId`, so that question was a scan.
CREATE INDEX IF NOT EXISTS "audit_logs_userId_createdAt_idx"
  ON "audit_logs"("userId", "createdAt");
