-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('BRANCH', 'PRODUCTION_HOUSE', 'CENTRAL_WAREHOUSE');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionVarianceReason" AS ENUM ('PRODUCTION_LOSS', 'DAMAGED', 'INGREDIENT_SHORTAGE', 'QUALITY_ISSUE', 'OTHER');

-- CreateEnum
CREATE TYPE "TransferVarianceReason" AS ENUM ('DAMAGED_IN_TRANSIT', 'MISSING', 'REJECTED_ON_ARRIVAL', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'PRODUCTION_CONSUMPTION';
ALTER TYPE "StockMovementType" ADD VALUE 'PRODUCTION_OUTPUT';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "managerId" TEXT,
ADD COLUMN     "openingHours" JSONB,
ADD COLUMN     "type" "LocationType" NOT NULL DEFAULT 'BRANCH';

-- CreateTable
CREATE TABLE "inventory_stock" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "storageLocationId" TEXT,
    "available" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inTransit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "requestedQty" DOUBLE PRECISION NOT NULL,
    "sentQty" DOUBLE PRECISION,
    "receivedQty" DOUBLE PRECISION,
    "variance" DOUBLE PRECISION,
    "varianceReason" "TransferVarianceReason",
    "varianceNote" TEXT,
    "unit" "StockUnit",
    "batchId" TEXT,
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_specs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outputItemId" TEXT NOT NULL,
    "outputQty" DOUBLE PRECISION NOT NULL,
    "shelfLifeDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_spec_items" (
    "id" TEXT NOT NULL,
    "specId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "StockUnit",

    CONSTRAINT "production_spec_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "specId" TEXT,
    "number" TEXT NOT NULL,
    "batchNumber" TEXT,
    "status" "ProductionStatus" NOT NULL DEFAULT 'DRAFT',
    "plannedQty" DOUBLE PRECISION NOT NULL,
    "actualQty" DOUBLE PRECISION,
    "unit" "StockUnit",
    "variance" DOUBLE PRECISION,
    "varianceReason" "ProductionVarianceReason",
    "varianceNote" TEXT,
    "totalCost" INTEGER NOT NULL DEFAULT 0,
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "productionDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "notes" TEXT,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_consumption" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "StockUnit",
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "lineCost" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_consumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_outputs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "StockUnit",
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_stock_restaurantId_branchId_idx" ON "inventory_stock"("restaurantId", "branchId");

-- CreateIndex
CREATE INDEX "inventory_stock_restaurantId_itemId_idx" ON "inventory_stock"("restaurantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_itemId_branchId_key" ON "inventory_stock"("itemId", "branchId");

-- CreateIndex
CREATE INDEX "stock_transfers_restaurantId_status_idx" ON "stock_transfers"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_restaurantId_fromBranchId_idx" ON "stock_transfers"("restaurantId", "fromBranchId");

-- CreateIndex
CREATE INDEX "stock_transfers_restaurantId_toBranchId_idx" ON "stock_transfers"("restaurantId", "toBranchId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_restaurantId_number_key" ON "stock_transfers"("restaurantId", "number");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_transferId_idx" ON "stock_transfer_lines"("transferId");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_itemId_idx" ON "stock_transfer_lines"("itemId");

-- CreateIndex
CREATE INDEX "production_specs_restaurantId_isActive_idx" ON "production_specs"("restaurantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "production_spec_items_specId_itemId_key" ON "production_spec_items"("specId", "itemId");

-- CreateIndex
CREATE INDEX "production_orders_restaurantId_status_idx" ON "production_orders"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "production_orders_restaurantId_branchId_createdAt_idx" ON "production_orders"("restaurantId", "branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_restaurantId_number_key" ON "production_orders"("restaurantId", "number");

-- CreateIndex
CREATE INDEX "production_consumption_orderId_idx" ON "production_consumption"("orderId");

-- CreateIndex
CREATE INDEX "production_outputs_orderId_idx" ON "production_outputs"("orderId");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_storageLocationId_fkey" FOREIGN KEY ("storageLocationId") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_specs" ADD CONSTRAINT "production_specs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_specs" ADD CONSTRAINT "production_specs_outputItemId_fkey" FOREIGN KEY ("outputItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_spec_items" ADD CONSTRAINT "production_spec_items_specId_fkey" FOREIGN KEY ("specId") REFERENCES "production_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_spec_items" ADD CONSTRAINT "production_spec_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_specId_fkey" FOREIGN KEY ("specId") REFERENCES "production_specs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_consumption" ADD CONSTRAINT "production_consumption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_consumption" ADD CONSTRAINT "production_consumption_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_outputs" ADD CONSTRAINT "production_outputs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_outputs" ADD CONSTRAINT "production_outputs_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_outputs" ADD CONSTRAINT "production_outputs_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: give every existing item a location stock row at its own branch, or
-- at the restaurant's default branch when it was never assigned one. Existing
-- balances are preserved exactly — this only records *where* stock already was,
-- which until now the system could not express.
INSERT INTO "inventory_stock" ("id", "restaurantId", "itemId", "branchId", "available", "reserved", "inTransit", "createdAt", "updatedAt")
SELECT
  md5(random()::text || i."id")            AS "id",
  i."restaurantId",
  i."id"                                   AS "itemId",
  COALESCE(i."branchId", b."id")           AS "branchId",
  i."quantity"                             AS "available",
  0, 0, NOW(), NOW()
FROM "inventory_items" i
LEFT JOIN LATERAL (
  SELECT br."id" FROM "branches" br
  WHERE br."restaurantId" = i."restaurantId" AND br."deletedAt" IS NULL
  ORDER BY br."isDefault" DESC, br."createdAt" ASC
  LIMIT 1
) b ON TRUE
WHERE COALESCE(i."branchId", b."id") IS NOT NULL
ON CONFLICT ("itemId", "branchId") DO NOTHING;
