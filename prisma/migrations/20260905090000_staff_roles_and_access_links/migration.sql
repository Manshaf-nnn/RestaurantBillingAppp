-- Custom roles, and access links that know where they lead.
--
-- Three parts, in order: the enum the new column needs, the table custom roles
-- live in, and the columns that turn an invite from "a role name" into "a role,
-- at a branch, for a person, in a mode".
--
-- Nothing here is destructive and nothing back-fills a value that changes
-- behaviour. Every existing invite becomes SHARED_DEVICE, which is precisely
-- what every existing invite already does — opening the URL signs the device
-- in. Every existing user keeps `staffRoleId` NULL, which means "use the
-- preset defaults", which is what they have today. The day this deploys,
-- nobody's access moves.


-- ── 1. How a link signs somebody in ──────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InviteMode') THEN
    CREATE TYPE "InviteMode" AS ENUM ('PERSONAL', 'SHARED_DEVICE');
  END IF;
END
$$;


-- ── 2. Roles a restaurant defined for itself ─────────────────────────────────
--
-- `preset` is not decoration. UserRole stays the Prisma enum because ROLE_HOME,
-- the edge middleware gate and visibleBranchIds all switch on it; a custom role
-- names the built-in it behaves like so those keep working unchanged.
--
-- `permissions` is the complete list, not a set of additions. That is what makes
-- switching a feature OFF possible at all.

CREATE TABLE IF NOT EXISTS "staff_roles" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "preset"       "UserRole" NOT NULL,
  "permissions"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "branchId"     TEXT,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"    TIMESTAMP(3),
  CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_roles_restaurantId_name_key"
  ON "staff_roles"("restaurantId", "name");
CREATE INDEX IF NOT EXISTS "staff_roles_restaurantId_isActive_idx"
  ON "staff_roles"("restaurantId", "isActive");

ALTER TABLE "staff_roles" DROP CONSTRAINT IF EXISTS "staff_roles_restaurantId_fkey";
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A deleted location must not take its roles' members' access with it, so the
-- branch goes null and the member falls back to their own.
ALTER TABLE "staff_roles" DROP CONSTRAINT IF EXISTS "staff_roles_branchId_fkey";
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "staff_roles" DROP CONSTRAINT IF EXISTS "staff_roles_createdById_fkey";
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── 3. Who holds one ─────────────────────────────────────────────────────────
--
-- NULL means "use the preset defaults" — every row today, and every row after
-- this migration. ON DELETE SET NULL because deleting a role must demote its
-- members to their preset, never orphan or delete the people.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "staffRoleId" TEXT;

CREATE INDEX IF NOT EXISTS "users_restaurantId_staffRoleId_idx"
  ON "users"("restaurantId", "staffRoleId");

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_staffRoleId_fkey";
ALTER TABLE "users" ADD CONSTRAINT "users_staffRoleId_fkey"
  FOREIGN KEY ("staffRoleId") REFERENCES "staff_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── 4. Links that know where they lead ───────────────────────────────────────
--
-- `branchId` is the important one. Until now an invite carried a role and
-- nothing else, and the account it created was left with no branch — which
-- makes visibleBranchIds return [] ("sees nothing"), so the person landed on a
-- screen that was empty and stayed empty, with no error to explain it.

ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "mode" "InviteMode" NOT NULL DEFAULT 'SHARED_DEVICE';
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "branchId"    TEXT;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "staffRoleId" TEXT;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "userId"      TEXT;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "label"       TEXT;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "lastUsedAt"  TIMESTAMP(3);
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "useCount"    INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "invites_restaurantId_branchId_idx"
  ON "invites"("restaurantId", "branchId");

ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_branchId_fkey";
ALTER TABLE "invites" ADD CONSTRAINT "invites_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_staffRoleId_fkey";
ALTER TABLE "invites" ADD CONSTRAINT "invites_staffRoleId_fkey"
  FOREIGN KEY ("staffRoleId") REFERENCES "staff_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CASCADE, unlike the two above: a personal link is *for* that person. If the
-- account goes, the link that signs in as it must go with it rather than sit
-- there resolving to nobody.
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_userId_fkey";
ALTER TABLE "invites" ADD CONSTRAINT "invites_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
