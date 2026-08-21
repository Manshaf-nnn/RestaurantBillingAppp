-- Owner → branch instructions.
--
-- Purely additive: one new table and two new enums. Nothing existing is touched,
-- so this is safe to apply to a live database with orders in flight.

CREATE TYPE "InstructionPriority" AS ENUM ('NORMAL', 'URGENT');
CREATE TYPE "InstructionStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

CREATE TABLE "branch_instructions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "priority" "InstructionPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "InstructionStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL,
    "doneById" TEXT,
    "doneByName" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_instructions_pkey" PRIMARY KEY ("id")
);

-- The two queries this table exists to answer: "what is outstanding across the
-- group" and "what is outstanding here".
CREATE INDEX "branch_instructions_restaurantId_status_createdAt_idx"
    ON "branch_instructions"("restaurantId", "status", "createdAt");
CREATE INDEX "branch_instructions_restaurantId_branchId_status_idx"
    ON "branch_instructions"("restaurantId", "branchId", "status");

ALTER TABLE "branch_instructions" ADD CONSTRAINT "branch_instructions_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting a location takes its instructions with it; they mean nothing without it.
ALTER TABLE "branch_instructions" ADD CONSTRAINT "branch_instructions_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- But a departed member of staff must not delete the record of what they asked
-- for or what they did. The name is stored alongside the id for exactly this.
ALTER TABLE "branch_instructions" ADD CONSTRAINT "branch_instructions_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "branch_instructions" ADD CONSTRAINT "branch_instructions_doneById_fkey"
    FOREIGN KEY ("doneById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
