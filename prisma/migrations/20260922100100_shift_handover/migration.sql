-- recorrection.md §2 — a shift handover for every role.
--
-- A cashier's handover already existed as cash_handovers: the till going from
-- one drawer session to the next. Kitchen, waiters and everyone else had an
-- unaddressed note and nothing else. This is the general record — who handed
-- over to whom, where, what the summary said at confirm, and whether the
-- receiver accepted — with the cash handover nested by cashHandoverId when the
-- outgoing person had a till.
--
-- A new table and a new enum: nothing existing is touched.

CREATE TYPE "ShiftHandoverStatus" AS ENUM ('PENDING_ACCEPTANCE', 'COMPLETED', 'REJECTED', 'CANCELLED');

CREATE TABLE "shift_handovers" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "fromShiftId" TEXT,
    "cashHandoverId" TEXT,
    "status" "ShiftHandoverStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "summary" JSONB NOT NULL,
    "notes" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "shift_handovers_pkey" PRIMARY KEY ("id")
);

-- Fresh table: no duplicates can exist yet, so the unique index is safe.
CREATE UNIQUE INDEX "shift_handovers_cashHandoverId_key" ON "shift_handovers"("cashHandoverId");
CREATE INDEX "shift_handovers_restaurantId_status_idx" ON "shift_handovers"("restaurantId", "status");
CREATE INDEX "shift_handovers_restaurantId_toUserId_status_idx" ON "shift_handovers"("restaurantId", "toUserId", "status");
CREATE INDEX "shift_handovers_restaurantId_fromUserId_status_idx" ON "shift_handovers"("restaurantId", "fromUserId", "status");
CREATE INDEX "shift_handovers_restaurantId_branchId_createdAt_idx" ON "shift_handovers"("restaurantId", "branchId", "createdAt");

ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_cashHandoverId_fkey" FOREIGN KEY ("cashHandoverId") REFERENCES "cash_handovers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
