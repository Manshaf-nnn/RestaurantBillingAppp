-- CreateEnum
CREATE TYPE "DiscountScope" AS ENUM ('BILL', 'ITEM', 'CATEGORY');

-- CreateEnum
CREATE TYPE "CustomerGroup" AS ENUM ('GENERAL', 'REGULAR', 'VIP', 'STAFF', 'CORPORATE');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "birthday" TIMESTAMP(3),
ADD COLUMN     "group" "CustomerGroup" NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketingConsentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "coupons" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "categoryIds" JSONB,
ADD COLUMN     "customerGroup" "CustomerGroup",
ADD COLUMN     "daysOfWeek" JSONB,
ADD COLUMN     "endHour" INTEGER,
ADD COLUMN     "itemIds" JSONB,
ADD COLUMN     "scope" "DiscountScope" NOT NULL DEFAULT 'BILL',
ADD COLUMN     "startHour" INTEGER;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

