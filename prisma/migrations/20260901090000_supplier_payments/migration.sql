-- Money paid to suppliers.
--
-- The one thing missing before a supplier ledger could exist. Purchases and
-- receipts were recorded and nothing anywhere could say "we paid ABC
-- Distributors 30,000", so "what do we owe" had no answer.
--
-- Purely additive: one new table, nothing existing altered.
--
-- Note what is NOT here: no balance column on suppliers. The balance is derived
-- from the documents on every read — received value owed, less payments and
-- returns — because a stored balance is a second source of truth that drifts
-- from the first.

CREATE TABLE "supplier_payments" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "notes" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- The two questions this table answers: one supplier's statement, and
-- everything paid out in a period.
CREATE INDEX "supplier_payments_restaurantId_supplierId_paidAt_idx"
    ON "supplier_payments"("restaurantId", "supplierId", "paidAt");
CREATE INDEX "supplier_payments_restaurantId_paidAt_idx"
    ON "supplier_payments"("restaurantId", "paidAt");

ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A supplier's payments go with the supplier; without them they mean nothing.
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- But a deleted order must not delete the record that money changed hands. The
-- payment survives, unallocated, and still counts against the balance.
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_purchaseId_fkey"
    FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nor may a departed member of staff erase who paid. The name is stored
-- alongside the id for exactly this.
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
