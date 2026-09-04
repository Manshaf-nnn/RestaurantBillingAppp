-- Platform operations: error context, the job queue, MFA, maintenance, restore tests.
-- production.md §7 (monitoring), §10 (backups), §13 (jobs), §14 (security).
--
-- All additive. Every new column is nullable or defaulted, every new table is
-- empty, and nothing existing is rewritten — an old ErrorLog row simply has no
-- requestId, which is true and is what it should say.

-- ── §7/§12  Errors that can actually be investigated ────────────────────────
--
-- These rows carried a restaurant id and a route. §7 asks for a request id, the
-- operation, the branch, the user and useful detail, because "a page failed for
-- somebody somewhere" is not something an operator can act on.
ALTER TABLE "error_logs" ADD COLUMN "branchId"     TEXT;
ALTER TABLE "error_logs" ADD COLUMN "userId"       TEXT;
ALTER TABLE "error_logs" ADD COLUMN "requestId"    TEXT;
ALTER TABLE "error_logs" ADD COLUMN "operation"    TEXT;
ALTER TABLE "error_logs" ADD COLUMN "severity"     TEXT NOT NULL DEFAULT 'ERROR';
ALTER TABLE "error_logs" ADD COLUMN "entity"       TEXT;
ALTER TABLE "error_logs" ADD COLUMN "entityId"     TEXT;
ALTER TABLE "error_logs" ADD COLUMN "resolvedAt"   TIMESTAMP(3);
ALTER TABLE "error_logs" ADD COLUMN "resolvedById" TEXT;
ALTER TABLE "error_logs" ADD COLUMN "resolution"   TEXT;

CREATE INDEX "error_logs_severity_createdAt_idx" ON "error_logs"("severity", "createdAt");
CREATE INDEX "error_logs_requestId_idx" ON "error_logs"("requestId");

-- The restaurant link existed as a bare column with no constraint, so deleting a
-- tenant left its errors behind pointing at nothing — and this database already
-- holds such rows, which is how the missing constraint announced itself: adding
-- the foreign key failed on them.
--
-- They are detached from every tenant, so they cannot be attributed, cannot be
-- shown on any screen (every reader is tenant-scoped) and cannot be actioned.
-- Detaching them from the dead id is the honest repair: the error text and its
-- timestamp survive as platform-level rows, and only the pointer to a
-- restaurant that no longer exists is dropped. Nothing readable is lost.
UPDATE "error_logs" SET "restaurantId" = NULL
 WHERE "restaurantId" IS NOT NULL
   AND "restaurantId" NOT IN (SELECT id FROM "restaurants");

ALTER TABLE "error_logs" ADD CONSTRAINT "error_logs_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "error_logs" ADD CONSTRAINT "error_logs_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "error_logs" ADD CONSTRAINT "error_logs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── §13  One job queue, drained by one scheduled function ───────────────────
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

CREATE TABLE "jobs" (
    "id"           TEXT NOT NULL,
    "kind"         TEXT NOT NULL,
    "status"       "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "restaurantId" TEXT,
    "payload"      JSONB,
    "runAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts"     INTEGER NOT NULL DEFAULT 0,
    "maxAttempts"  INTEGER NOT NULL DEFAULT 5,
    "lastError"    TEXT,
    "result"       TEXT,
    "startedAt"    TIMESTAMP(3),
    "finishedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "dedupeKey"    TEXT,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- The claim query is `WHERE status='QUEUED' AND runAt <= now() ORDER BY runAt`.
CREATE INDEX "jobs_status_runAt_idx" ON "jobs"("status", "runAt");
CREATE INDEX "jobs_kind_status_idx" ON "jobs"("kind", "status");
CREATE INDEX "jobs_restaurantId_createdAt_idx" ON "jobs"("restaurantId", "createdAt");
-- Stops the scheduler queueing tonight's integrity check twice.
CREATE UNIQUE INDEX "jobs_dedupeKey_key" ON "jobs"("dedupeKey");

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── §14  MFA for privileged accounts ────────────────────────────────────────
--
-- The secret is encrypted rather than hashed because TOTP has to recompute the
-- code from it; `mfaEnabledAt` is what actually turns MFA on, so an abandoned
-- half-finished enrolment cannot lock anyone out.
ALTER TABLE "users" ADD COLUMN "mfaSecret"    TEXT;
ALTER TABLE "users" ADD COLUMN "mfaEnabledAt" TIMESTAMP(3);

CREATE TABLE "mfa_recovery_codes" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "codeHash"  TEXT NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_recovery_codes_codeHash_key" ON "mfa_recovery_codes"("codeHash");
CREATE INDEX "mfa_recovery_codes_userId_usedAt_idx" ON "mfa_recovery_codes"("userId", "usedAt");

ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── §8  Maintenance, and the switches the operator owns ─────────────────────
CREATE TABLE "platform_settings" (
    "key"         TEXT NOT NULL,
    "value"       TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- ── §10  A backup nobody has restored is a belief, not a backup ─────────────
CREATE TABLE "restore_tests" (
    "id"           TEXT NOT NULL,
    "target"       TEXT NOT NULL,
    "outcome"      TEXT NOT NULL,
    "restoredTo"   TIMESTAMP(3),
    "durationSec"  INTEGER,
    "notes"        TEXT,
    "testedById"   TEXT,
    "testedByName" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restore_tests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "restore_tests_createdAt_idx" ON "restore_tests"("createdAt");
