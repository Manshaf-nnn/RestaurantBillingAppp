-- Every print on the record (§80): fire-and-forget printing leaves no trace,
-- and a reprint should be the SAME document, not a fresh reconstruction.
CREATE TYPE "PrintJobKind" AS ENUM ('BILL', 'RECEIPT', 'KITCHEN');
CREATE TYPE "PrintJobStatus" AS ENUM ('PRINTED', 'FAILED');

CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT,
    "orderId" TEXT,
    "kind" "PrintJobKind" NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'PRINTED',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "print_jobs_restaurantId_createdAt_idx" ON "print_jobs"("restaurantId", "createdAt");
CREATE INDEX "print_jobs_orderId_idx" ON "print_jobs"("orderId");

ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
