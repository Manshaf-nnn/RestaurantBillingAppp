-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('COD', 'NET_7', 'NET_15', 'NET_30', 'NET_60', 'CUSTOM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PurchaseStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "PurchaseStatus" ADD VALUE 'APPROVED';
ALTER TYPE "PurchaseStatus" ADD VALUE 'PARTIALLY_RECEIVED';

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "company" TEXT,
ADD COLUMN     "paymentTerms" "PaymentTerms" NOT NULL DEFAULT 'COD',
ADD COLUMN     "paymentTermsNote" TEXT,
ADD COLUMN     "taxNumber" TEXT;

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "discount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "expectedAt" TIMESTAMP(3),
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "subtotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxTotal" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "purchase_items" ADD COLUMN     "receivedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "rejectedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "unit" "StockUnit";

-- CreateTable
CREATE TABLE "supplier_items" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "supplierSku" TEXT,
    "purchaseUnit" "StockUnit",
    "unitsPerPurchaseUnit" DOUBLE PRECISION,
    "price" INTEGER NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER,
    "minOrderQty" DOUBLE PRECISION,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierRef" TEXT,
    "notes" TEXT,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseItemId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "acceptedQty" DOUBLE PRECISION NOT NULL,
    "rejectedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" "StockUnit",
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "rejectReason" TEXT,
    "batchNo" TEXT,
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "supplierId" TEXT,
    "number" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_lines" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "StockUnit",
    "unitCost" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_price_history" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "supplierId" TEXT,
    "unitCost" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "StockUnit",
    "receiptId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_items_restaurantId_itemId_idx" ON "supplier_items"("restaurantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_items_supplierId_itemId_key" ON "supplier_items"("supplierId", "itemId");

-- CreateIndex
CREATE INDEX "goods_receipts_restaurantId_purchaseId_idx" ON "goods_receipts"("restaurantId", "purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_restaurantId_number_key" ON "goods_receipts"("restaurantId", "number");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_receiptId_idx" ON "goods_receipt_lines"("receiptId");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_itemId_idx" ON "goods_receipt_lines"("itemId");

-- CreateIndex
CREATE INDEX "purchase_returns_restaurantId_createdAt_idx" ON "purchase_returns"("restaurantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_restaurantId_number_key" ON "purchase_returns"("restaurantId", "number");

-- CreateIndex
CREATE INDEX "purchase_return_lines_returnId_idx" ON "purchase_return_lines"("returnId");

-- CreateIndex
CREATE INDEX "purchase_price_history_restaurantId_itemId_recordedAt_idx" ON "purchase_price_history"("restaurantId", "itemId", "recordedAt");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "purchase_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_price_history" ADD CONSTRAINT "purchase_price_history_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_price_history" ADD CONSTRAINT "purchase_price_history_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

