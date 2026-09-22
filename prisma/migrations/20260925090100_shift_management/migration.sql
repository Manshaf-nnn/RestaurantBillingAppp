-- shifthandover.md — shift templates, the rota, and the links that tie a
-- worked session and a handover back to them.
--
-- Two new tables; the rest is nullable columns on tables that already exist.
-- Nothing is dropped, nothing is backfilled, and every new unique index is
-- either on a fresh table or on a column added here (so no existing row can
-- collide).

CREATE TYPE "ShiftAssignmentStatus" AS ENUM ('PLANNED', 'STARTED', 'COMPLETED', 'CANCELLED');

-- ── §1 Shift templates ──────────────────────────────────────────────────────
CREATE TABLE "shift_templates" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "roles" "UserRole"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shift_templates_restaurantId_branchId_name_key" ON "shift_templates"("restaurantId", "branchId", "name");
CREATE INDEX "shift_templates_restaurantId_isActive_sortOrder_idx" ON "shift_templates"("restaurantId", "isActive", "sortOrder");

ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── §2 Shift assignments (the rota) ─────────────────────────────────────────
CREATE TABLE "shift_assignments" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "templateId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "scheduledStartAt" TIMESTAMP(3) NOT NULL,
    "scheduledEndAt" TIMESTAMP(3) NOT NULL,
    "status" "ShiftAssignmentStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "createdById" TEXT,
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- The same person on the same shift twice in one day is a duplicate, not a rota.
CREATE UNIQUE INDEX "shift_assignments_userId_templateId_date_key" ON "shift_assignments"("userId", "templateId", "date");
CREATE INDEX "shift_assignments_restaurantId_branchId_date_idx" ON "shift_assignments"("restaurantId", "branchId", "date");
CREATE INDEX "shift_assignments_userId_date_idx" ON "shift_assignments"("userId", "date");
CREATE INDEX "shift_assignments_restaurantId_date_status_idx" ON "shift_assignments"("restaurantId", "date", "status");

ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "shift_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── §3 The worked session links to what was rostered ────────────────────────
ALTER TABLE "staff_shifts"
  ADD COLUMN "assignmentId" TEXT,
  ADD COLUMN "templateId" TEXT,
  ADD COLUMN "scheduledStartAt" TIMESTAMP(3),
  ADD COLUMN "scheduledEndAt" TIMESTAMP(3),
  ADD COLUMN "roleAtStart" "UserRole";

-- New column: every existing row is NULL, and NULLs never collide.
CREATE UNIQUE INDEX "staff_shifts_assignmentId_key" ON "staff_shifts"("assignmentId");

ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "shift_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── §4 The handover: one in flight per person, and a real link to the shift ──
ALTER TABLE "shift_handovers"
  ADD COLUMN "pendingFromKey" TEXT,
  ADD COLUMN "pendingToKey" TEXT;

-- New columns, so NULL everywhere today. The application sets them for rows
-- created from now on; a handover already waiting when this deploys keeps
-- working through the status checks it always had.
CREATE UNIQUE INDEX "shift_handovers_pendingFromKey_key" ON "shift_handovers"("pendingFromKey");
CREATE UNIQUE INDEX "shift_handovers_pendingToKey_key" ON "shift_handovers"("pendingToKey");

-- `fromShiftId` was a loose string. Before it becomes a foreign key, any value
-- pointing at a shift that no longer exists is cleared — otherwise the
-- constraint itself would refuse to be added, and the deploy with it.
UPDATE "shift_handovers" h
   SET "fromShiftId" = NULL
 WHERE h."fromShiftId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "staff_shifts" s WHERE s."id" = h."fromShiftId");

ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_fromShiftId_fkey" FOREIGN KEY ("fromShiftId") REFERENCES "staff_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
