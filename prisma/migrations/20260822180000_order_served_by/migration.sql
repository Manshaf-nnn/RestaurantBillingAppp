-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "servedById" TEXT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_servedById_fkey" FOREIGN KEY ("servedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

