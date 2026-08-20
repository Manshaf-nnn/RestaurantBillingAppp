-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('REFUND', 'DISCOUNT', 'STOCK_ADJUSTMENT', 'PURCHASE_ORDER', 'STOCK_TRANSFER', 'PRICE_OVERRIDE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'INVENTORY_MANAGER';
ALTER TYPE "UserRole" ADD VALUE 'PURCHASING_MANAGER';
ALTER TYPE "UserRole" ADD VALUE 'WAREHOUSE_STAFF';
ALTER TYPE "UserRole" ADD VALUE 'ACCOUNTANT';

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "approvalPolicy" JSONB;

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT,
    "kind" "ApprovalKind" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "amount" INTEGER,
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_requests_restaurantId_status_requestedAt_idx" ON "approval_requests"("restaurantId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "approval_requests_restaurantId_kind_status_idx" ON "approval_requests"("restaurantId", "kind", "status");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

