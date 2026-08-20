-- AlterTable
ALTER TABLE "stock_transfers" ADD COLUMN     "fromStorageId" TEXT,
ADD COLUMN     "toStorageId" TEXT;
-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_fromStorageId_fkey" FOREIGN KEY ("fromStorageId") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_toStorageId_fkey" FOREIGN KEY ("toStorageId") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
