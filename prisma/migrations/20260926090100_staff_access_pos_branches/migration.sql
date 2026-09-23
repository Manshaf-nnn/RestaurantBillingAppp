-- staff.A.md §3, §4, §5, §6, §10 — per-staff denials, several branches per
-- person, the POS_OPEN_DRAWER split, and the Cashier → POS move.
--
-- Everything here is additive or an in-place UPDATE. No column is dropped, no
-- row is deleted, and the retired 'CASHIER' enum value stays in the type.

-- ── §3. Permissions taken away from ONE person ──────────────────────────────
--
-- Beside `permissions`, which only ever adds. Subtracted last in
-- `permissionsFor`, so it beats the role defaults, a saved role and the
-- per-user grant alike. Defaulted empty, so every existing account is
-- unaffected on the day this lands.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "deniedPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── §4. Extra sites somebody may work ───────────────────────────────────────
--
-- `users.branchId` stays the HOME site. This is reach on top of it, so nobody
-- needs a second account to cover a second shop. A join table rather than an
-- array column: the foreign key is what makes a closed branch drop out of
-- everyone's reach without a sweep.
CREATE TABLE IF NOT EXISTS "user_branches" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "branchId"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_branches_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "user_branches"
    ADD CONSTRAINT "user_branches_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_branches"
    ADD CONSTRAINT "user_branches_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One row per person per site. The unique index is what makes granting the
-- same branch twice a no-op rather than a duplicate that has to be de-duped on
-- every read.
CREATE UNIQUE INDEX IF NOT EXISTS "user_branches_userId_branchId_key"
  ON "user_branches"("userId", "branchId");
CREATE INDEX IF NOT EXISTS "user_branches_branchId_idx"
  ON "user_branches"("branchId");

-- ── §10. Cashier becomes POS ────────────────────────────────────────────────
--
-- Six columns persist a UserRole. All six move together, because a half-moved
-- rename is worse than either name: a shift assignment saying CASHIER against
-- a user saying POS reads as two different people.
--
-- The enum value itself was added by the previous migration, which had to
-- commit first — PostgreSQL refuses to use a new enum value in the transaction
-- that created it.
UPDATE "users"             SET "role"        = 'POS' WHERE "role"        = 'CASHIER';
UPDATE "staff_roles"       SET "preset"      = 'POS' WHERE "preset"      = 'CASHIER';
UPDATE "invites"           SET "role"        = 'POS' WHERE "role"        = 'CASHIER';
UPDATE "shift_assignments" SET "role"        = 'POS' WHERE "role"        = 'CASHIER';
UPDATE "staff_shifts"      SET "roleAtStart" = 'POS' WHERE "roleAtStart" = 'CASHIER';

-- An array column, so element-wise. `array_replace` leaves a template that
-- already names POS alone and does not disturb the order of the other roles.
UPDATE "shift_templates"
   SET "roles" = array_replace("roles", 'CASHIER'::"UserRole", 'POS'::"UserRole")
 WHERE 'CASHIER'::"UserRole" = ANY("roles");

-- ── §6. Opening a till becomes its own permission ───────────────────────────
--
-- 'pos.openDrawer' is split from 'cashDrawer.operate' in SPLIT_FROM, which is
-- what keeps the BUILT-IN roles whole. Splits deliberately do not apply to a
-- saved StaffRole — an explicit list is explicit — so without this backfill
-- every custom role that can work a till would quietly lose the ability to
-- open one the moment this deploys. Nobody's access changes.
UPDATE "staff_roles"
   SET "permissions" = array_append("permissions", 'pos.openDrawer')
 WHERE 'cashDrawer.operate' = ANY("permissions")
   AND NOT ('pos.openDrawer' = ANY("permissions"));

-- The same for anybody carrying the till permission as a personal grant.
UPDATE "users"
   SET "permissions" = array_append("permissions", 'pos.openDrawer')
 WHERE 'cashDrawer.operate' = ANY("permissions")
   AND NOT ('pos.openDrawer' = ANY("permissions"));
