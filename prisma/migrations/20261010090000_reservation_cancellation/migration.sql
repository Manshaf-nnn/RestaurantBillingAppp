-- A cancelled booking keeps its reason, its time and who cancelled it, so the
-- reservations report can say how many were cancelled and why rather than
-- counting rows that were deleted.
ALTER TABLE "reservations" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "reservations" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "reservations" ADD COLUMN "cancelledByName" TEXT;
