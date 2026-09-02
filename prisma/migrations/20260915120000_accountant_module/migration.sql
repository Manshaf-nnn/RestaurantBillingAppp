-- The accountant's module (accountsds.md): formal expense categories and the
-- outgoing-payment workflow — DRAFT → SUBMITTED → APPROVED/REJECTED → PAID →
-- possibly REVERSED. Its own model by house precedent: a request with a life
-- after approval does not fit ApprovalRequest (the petty-cash lesson, three
-- times over in code comments). Two system-only cash movement types keep an
-- approved expense's drawer row forever distinguishable from a hand-keyed
-- cash-out. Hand-curated from `prisma migrate diff`; the deliberate
-- recipe_items / partial-index drift is excluded as always.

-- CreateEnum
CREATE TYPE "OutgoingPaymentKind" AS ENUM ('SUPPLIER', 'EXPENSE');

-- CreateEnum
CREATE TYPE "OutgoingPaymentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'REVERSED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CashMovementType" ADD VALUE 'EXPENSE_PAID';
ALTER TYPE "CashMovementType" ADD VALUE 'EXPENSE_REVERSED';



-- AlterTable
ALTER TABLE "cash_movements" ADD COLUMN     "outgoingPaymentId" TEXT;

-- AlterTable


-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outgoing_payments" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "OutgoingPaymentKind" NOT NULL,
    "status" "OutgoingPaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "supplierId" TEXT,
    "purchaseId" TEXT,
    "expenseCategoryId" TEXT,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "supplierPaymentId" TEXT,
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outgoing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_categories_restaurantId_isActive_sortOrder_idx" ON "expense_categories"("restaurantId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_restaurantId_name_key" ON "expense_categories"("restaurantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "outgoing_payments_supplierPaymentId_key" ON "outgoing_payments"("supplierPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "outgoing_payments_reversalOfId_key" ON "outgoing_payments"("reversalOfId");

-- CreateIndex
CREATE INDEX "outgoing_payments_restaurantId_branchId_status_createdAt_idx" ON "outgoing_payments"("restaurantId", "branchId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "outgoing_payments_restaurantId_kind_status_paymentDate_idx" ON "outgoing_payments"("restaurantId", "kind", "status", "paymentDate");

-- CreateIndex
CREATE INDEX "outgoing_payments_restaurantId_supplierId_paymentDate_idx" ON "outgoing_payments"("restaurantId", "supplierId", "paymentDate");

-- CreateIndex
CREATE INDEX "outgoing_payments_restaurantId_expenseCategoryId_paymentDat_idx" ON "outgoing_payments"("restaurantId", "expenseCategoryId", "paymentDate");

-- CreateIndex
CREATE UNIQUE INDEX "outgoing_payments_restaurantId_number_key" ON "outgoing_payments"("restaurantId", "number");

-- CreateIndex

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "supplier_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "outgoing_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_outgoingPaymentId_fkey" FOREIGN KEY ("outgoingPaymentId") REFERENCES "outgoing_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Money out must be a positive amount; a correction is its own linked
-- reversal row, never a negative edit.
ALTER TABLE "outgoing_payments" ADD CONSTRAINT "outgoing_payments_amount_positive" CHECK ("amount" > 0);

-- The accountant's book opens with the ordinary categories, for restaurants
-- that already exist. New restaurants get the same set lazily on first read
-- (ensureDefaultCategories), so neither path depends on the other.
INSERT INTO "expense_categories" ("id", "restaurantId", "name", "sortOrder", "updatedAt")
SELECT
  'expc_' || substr(md5(r.id || ':' || c.name), 1, 20),
  r.id,
  c.name,
  c.ord,
  now()
FROM "restaurants" r
CROSS JOIN (VALUES
  ('Rent', 0), ('Utilities', 1), ('Salaries & wages', 2), ('Maintenance', 3),
  ('Cleaning', 4), ('Transport', 5), ('Marketing', 6), ('Software', 7),
  ('Bank charges', 8), ('Miscellaneous', 9)
) AS c(name, ord)
ON CONFLICT ("restaurantId", "name") DO NOTHING;
