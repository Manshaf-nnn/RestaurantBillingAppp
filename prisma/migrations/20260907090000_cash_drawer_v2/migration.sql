-- Cash drawer: registers, petty cash, handover, and a variance that has to be
-- explained.
--
-- What was here already: a session with an opening float, cash sales attributed
-- through payments.cashDrawerSessionId, two movement types, and two states.
--
-- What this adds, and why each one:
--
--   cash_registers          the till. Branch alone could not say WHICH drawer
--                           was short, and it made the uniqueness rule wrong in
--                           both directions.
--   openingPettyCash        a second pile of money answering a second question.
--                           Folding it into the float loses the distinction the
--                           whole petty cash control depends on.
--   activeRegisterKey       "one open session per till" and "one open session
--   activeCashierKey        per cashier", as database constraints rather than a
--                           read-then-write check that two concurrent submits
--                           both walk through.
--   varianceReason          a difference nobody explained on the night is a
--                           difference nobody can explain a week later.
--   PENDING_REVIEW          a big variance stops for a manager, and the drawer
--                           takes no more money while it waits.
--   petty_cash_requests     raise → approve → pay, where only PAID moves money.
--   cash_handovers          the chain of custody between two sessions.
--
-- Nothing here is destructive. Every existing session keeps its float, its
-- movements and its variance; the new columns are backfilled from what is
-- already true.


-- ── 1. Enum values ───────────────────────────────────────────────────────────
--
-- Postgres 12+ allows ADD VALUE inside a transaction (which is how Prisma runs
-- a migration file) as long as the new value is not USED in the same
-- transaction. Nothing below inserts or indexes on one, so this is safe.
--
-- PENDING_REVIEW goes BEFORE 'CLOSED' to match the order in schema.prisma, so a
-- later `migrate diff` sees no drift.

ALTER TYPE "CashDrawerStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW' BEFORE 'CLOSED';

ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'ADDITIONAL_CASH';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'CASH_REFUND';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'PETTY_CASH_PAID';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'PETTY_FUND_TOPUP';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'CASH_PAID_OUT';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'CASH_DROP';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'BANK_DEPOSIT';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'ADJUSTMENT_IN';
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'ADJUSTMENT_OUT';

DO $$ BEGIN
  CREATE TYPE "PettyCashSource" AS ENUM ('DRAWER', 'PETTY_FUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PettyCashStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CashHandoverStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 2. The till ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "cash_registers" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "branchId"     TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cash_registers_branchId_name_key"
  ON "cash_registers"("branchId", "name");
CREATE INDEX IF NOT EXISTS "cash_registers_restaurantId_isActive_idx"
  ON "cash_registers"("restaurantId", "isActive");

DO $$ BEGIN
  ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One "Counter 1" per live branch, so nothing has to be set up by hand and a
-- single-till restaurant never sees a register picker.
INSERT INTO "cash_registers" ("id", "restaurantId", "branchId", "name", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT
  concat('cr', replace(gen_random_uuid()::text, '-', '')),
  b."restaurantId",
  b."id",
  'Counter 1',
  true,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "branches" b
WHERE b."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "cash_registers" r WHERE r."branchId" = b."id");


-- ── 3. Petty cash ────────────────────────────────────────────────────────────
--
-- Created before cash_movements gains its foreign key to it.

CREATE TABLE IF NOT EXISTS "petty_cash_requests" (
  "id"            TEXT NOT NULL,
  "restaurantId"  TEXT NOT NULL,
  "branchId"      TEXT NOT NULL,
  "sessionId"     TEXT,
  "category"      TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "amount"        INTEGER NOT NULL,
  "reference"     TEXT,
  "paidFrom"      "PettyCashSource" NOT NULL DEFAULT 'PETTY_FUND',
  "status"        "PettyCashStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById"   TEXT,
  "decidedAt"     TIMESTAMP(3),
  "decisionNote"  TEXT,
  "paidById"      TEXT,
  "paidAt"        TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "petty_cash_requests_pkey" PRIMARY KEY ("id")
);

-- Named as Postgres truncates it at 63 characters, which is what Prisma expects
-- to find; spelling it out keeps `migrate diff` silent.
CREATE INDEX IF NOT EXISTS "petty_cash_requests_restaurantId_branchId_status_requestedA_idx"
  ON "petty_cash_requests"("restaurantId", "branchId", "status", "requestedAt");
CREATE INDEX IF NOT EXISTS "petty_cash_requests_sessionId_idx"
  ON "petty_cash_requests"("sessionId");

DO $$ BEGIN
  ALTER TABLE "petty_cash_requests" ADD CONSTRAINT "petty_cash_requests_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_requests" ADD CONSTRAINT "petty_cash_requests_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_requests" ADD CONSTRAINT "petty_cash_requests_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "cash_drawer_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_requests" ADD CONSTRAINT "petty_cash_requests_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_requests" ADD CONSTRAINT "petty_cash_requests_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_requests" ADD CONSTRAINT "petty_cash_requests_paidById_fkey"
    FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 4. The session grows up ──────────────────────────────────────────────────

ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "registerId"        TEXT;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "sessionNumber"     TEXT;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "openingPettyCash"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "varianceReason"    TEXT;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "reviewedById"      TEXT;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "reviewedAt"        TIMESTAMP(3);
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "reviewNote"        TEXT;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "activeRegisterKey" TEXT;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN IF NOT EXISTS "activeCashierKey"  TEXT;

-- Every existing session belongs to its branch's Counter 1.
UPDATE "cash_drawer_sessions" s
SET "registerId" = r."id"
FROM "cash_registers" r
WHERE r."branchId" = s."branchId" AND s."registerId" IS NULL;

-- A branch that was soft-deleted got no register above, so give it one now
-- rather than leaving its history unattached.
--
-- The DISTINCT is in a subquery, and that is load-bearing. `SELECT DISTINCT
-- gen_random_uuid(), branchId FROM sessions` cannot dedupe anything: the uuid
-- is evaluated per row, so every row is distinct, and a deleted branch with two
-- historical sessions inserts two registers named 'Counter 1' — which violates
-- the (branchId, name) unique index and aborts the whole migration. Distinct
-- branches first, one id generated per branch after.
INSERT INTO "cash_registers" ("id", "restaurantId", "branchId", "name", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT
  concat('cr', replace(gen_random_uuid()::text, '-', '')),
  orphans."restaurantId",
  orphans."branchId",
  'Counter 1',
  false,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT s."restaurantId", s."branchId"
  FROM "cash_drawer_sessions" s
  WHERE s."registerId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "cash_registers" r WHERE r."branchId" = s."branchId")
) AS orphans;

UPDATE "cash_drawer_sessions" s
SET "registerId" = r."id"
FROM "cash_registers" r
WHERE r."branchId" = s."branchId" AND s."registerId" IS NULL;

-- CD-<year>-<six digits>, numbered oldest first so the sequence reads like the
-- history it describes.
WITH numbered AS (
  SELECT "id",
         concat('CD-', to_char("openedAt", 'YYYY'), '-',
                lpad(row_number() OVER (ORDER BY "openedAt", "id")::text, 6, '0')) AS num
  FROM "cash_drawer_sessions"
  WHERE "sessionNumber" IS NULL
)
UPDATE "cash_drawer_sessions" s
SET "sessionNumber" = n.num
FROM numbered n
WHERE n."id" = s."id";

-- The open-session locks. A session takes both keys only if it is the newest
-- open one for BOTH its till and its cashier — because branch-level uniqueness
-- allowed states these constraints forbid, and a migration must not fail on
-- data the old rules permitted. Any older duplicate keeps NULL keys and stops
-- being an exception the moment it is closed.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (PARTITION BY "registerId" ORDER BY "openedAt" DESC, "id") AS reg_rank,
         row_number() OVER (PARTITION BY "openedById" ORDER BY "openedAt" DESC, "id") AS cashier_rank
  FROM "cash_drawer_sessions"
  WHERE "status" = 'OPEN'
)
UPDATE "cash_drawer_sessions" s
SET "activeRegisterKey" = s."registerId",
    "activeCashierKey"  = s."openedById"
FROM ranked r
WHERE r."id" = s."id" AND r.reg_rank = 1 AND r.cashier_rank = 1;

ALTER TABLE "cash_drawer_sessions" ALTER COLUMN "registerId"    SET NOT NULL;
ALTER TABLE "cash_drawer_sessions" ALTER COLUMN "sessionNumber" SET NOT NULL;

-- Per restaurant, not globally: the sequence belongs to each restaurant, so a
-- global index would make two tenants opening a till in the same second collide
-- on a number that means nothing to either of them.
CREATE UNIQUE INDEX IF NOT EXISTS "cash_drawer_sessions_restaurantId_sessionNumber_key"
  ON "cash_drawer_sessions"("restaurantId", "sessionNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "cash_drawer_sessions_activeRegisterKey_key"
  ON "cash_drawer_sessions"("activeRegisterKey");
CREATE UNIQUE INDEX IF NOT EXISTS "cash_drawer_sessions_activeCashierKey_key"
  ON "cash_drawer_sessions"("activeCashierKey");
CREATE INDEX IF NOT EXISTS "cash_drawer_sessions_registerId_openedAt_idx"
  ON "cash_drawer_sessions"("registerId", "openedAt");

DO $$ BEGIN
  ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_registerId_fkey"
    FOREIGN KEY ("registerId") REFERENCES "cash_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 5. Movements carry a reference and a petty cash link ─────────────────────

ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "reference"          TEXT;
ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "pettyCashRequestId" TEXT;
-- Which payment a refund movement is for. Without it there is no way to ask
-- which refunds were recorded against a drawer and which were not, and a refund
-- given when no drawer was open leaves nothing behind to notice.
ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "paymentId"          TEXT;

CREATE INDEX IF NOT EXISTS "cash_movements_sessionId_type_idx"
  ON "cash_movements"("sessionId", "type");
CREATE INDEX IF NOT EXISTS "cash_movements_paymentId_idx"
  ON "cash_movements"("paymentId");

DO $$ BEGIN
  ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_pettyCashRequestId_fkey"
    FOREIGN KEY ("pettyCashRequestId") REFERENCES "petty_cash_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 6. Handover ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "cash_handovers" (
  "id"             TEXT NOT NULL,
  "restaurantId"   TEXT NOT NULL,
  "branchId"       TEXT NOT NULL,
  "registerId"     TEXT NOT NULL,
  "fromSessionId"  TEXT NOT NULL,
  "toSessionId"    TEXT,
  "fromUserId"     TEXT NOT NULL,
  "toUserId"       TEXT NOT NULL,
  "expectedAmount" INTEGER NOT NULL,
  "countedAmount"  INTEGER NOT NULL,
  "variance"       INTEGER NOT NULL,
  "note"           TEXT,
  "status"         "CashHandoverStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt"     TIMESTAMP(3),
  CONSTRAINT "cash_handovers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cash_handovers_restaurantId_branchId_createdAt_idx"
  ON "cash_handovers"("restaurantId", "branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "cash_handovers_toUserId_status_idx"
  ON "cash_handovers"("toUserId", "status");

DO $$ BEGIN
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_registerId_fkey"
    FOREIGN KEY ("registerId") REFERENCES "cash_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_fromSessionId_fkey"
    FOREIGN KEY ("fromSessionId") REFERENCES "cash_drawer_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_toSessionId_fkey"
    FOREIGN KEY ("toSessionId") REFERENCES "cash_drawer_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_fromUserId_fkey"
    FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_toUserId_fkey"
    FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
