-- Payment & discount model made spec-shaped (AUDIT.md Slice 2, migration set A).
--
-- Hand-curated from `prisma migrate diff`: the raw diff also wanted to drop
-- `recipe_items` (deliberately parked in the database for one release, see the
-- schema comment above RestaurantTable) and recreate the idempotency index
-- (it exists as a PARTIAL index, invisible to the schema diff). Neither
-- belongs here.

-- CreateEnum
CREATE TYPE "LoyaltyEntryKind" AS ENUM ('EARNED', 'REDEEMED', 'RETURNED', 'ADJUSTED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'OTHER';

-- ── The discount split ───────────────────────────────────────────────────────
-- `discountTotal` was one blob, which is why applying a manual discount used
-- to erase the coupon underneath it. The two columns are the truth from now
-- on; discountTotal stays as their sum because every report reads it.
ALTER TABLE "orders" ADD COLUMN "couponDiscount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "manualDiscount" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the coupon's own redemption rows: what the coupon took is
-- recorded there, and whatever remains of the blob was manual. LEAST guards
-- the handful of orders where a later manual discount overwrote the blob to
-- less than the coupon had taken (the exact bug being retired).
UPDATE "orders" o
SET "couponDiscount" = LEAST(o."discountTotal", r.total),
    "manualDiscount" = o."discountTotal" - LEAST(o."discountTotal", r.total)
FROM (
  SELECT "orderId", SUM(amount) AS total
  FROM "coupon_redemptions"
  GROUP BY "orderId"
) r
WHERE r."orderId" = o.id;

UPDATE "orders"
SET "manualDiscount" = "discountTotal"
WHERE "couponDiscount" = 0
  AND "manualDiscount" = 0
  AND "discountTotal" <> 0;

-- ── Refunds become rows, not edits ───────────────────────────────────────────
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reason" TEXT NOT NULL,
    "refundedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refunds_restaurantId_createdAt_idx" ON "refunds"("restaurantId", "createdAt");
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refundedById_fkey" FOREIGN KEY ("refundedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every payment that was flipped to REFUNDED under the old scheme
-- becomes one full-amount refund row, dated by the flip's updatedAt and
-- carrying the reason that was stored in failureReason.
INSERT INTO "refunds" ("id", "restaurantId", "orderId", "paymentId", "amount", "method", "reason", "createdAt")
SELECT
  'rfnd_' || substr(md5(p.id), 1, 20),
  p."restaurantId",
  p."orderId",
  p.id,
  p.amount,
  p.method,
  COALESCE(NULLIF(p."failureReason", ''), 'Refunded before refunds were recorded'),
  p."updatedAt"
FROM "payments" p
WHERE p.status = 'REFUNDED';

-- ── The loyalty ledger (§72) ─────────────────────────────────────────────────
CREATE TABLE "loyalty_entries" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "points" INTEGER NOT NULL,
    "kind" "LoyaltyEntryKind" NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "loyalty_entries_restaurantId_customerId_createdAt_idx" ON "loyalty_entries"("restaurantId", "customerId", "createdAt");
CREATE INDEX "loyalty_entries_orderId_idx" ON "loyalty_entries"("orderId");

ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Opening balances: history before this table cannot be reconstructed, so each
-- customer's current balance is captured as one ADJUSTED entry. From this row
-- on, SUM(points) per customer equals the cached balance.
INSERT INTO "loyalty_entries" ("id", "restaurantId", "customerId", "points", "kind", "note")
SELECT
  'lyop_' || substr(md5(c.id), 1, 20),
  c."restaurantId",
  c.id,
  c."loyaltyPoints",
  'ADJUSTED',
  'Opening balance when the loyalty ledger began'
FROM "customers" c
WHERE c."loyaltyPoints" <> 0;

-- ── Named counters ───────────────────────────────────────────────────────────
CREATE TABLE "restaurant_counters" (
    "restaurantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "restaurant_counters_pkey" PRIMARY KEY ("restaurantId","key")
);

ALTER TABLE "restaurant_counters" ADD CONSTRAINT "restaurant_counters_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed each restaurant's invoice counter for the current year at the number
-- already issued, so the sequence continues instead of restarting at 1.
INSERT INTO "restaurant_counters" ("restaurantId", "key", "value")
SELECT
  i."restaurantId",
  'invoice:' || to_char(now(), 'YYYY'),
  COUNT(*)
FROM "invoices" i
WHERE i."issuedAt" >= date_trunc('year', now())
GROUP BY i."restaurantId";

-- ── The books cannot go negative (first CHECKs in the schema) ────────────────
-- Pre-clean anything the old code let drift below zero; the constraint then
-- keeps it out for good.
UPDATE "customers" SET "loyaltyPoints" = 0 WHERE "loyaltyPoints" < 0;
UPDATE "orders" SET "paidTotal" = 0 WHERE "paidTotal" < 0;

ALTER TABLE "customers" ADD CONSTRAINT "customers_loyaltyPoints_nonneg" CHECK ("loyaltyPoints" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_money_nonneg" CHECK (
  "subtotal" >= 0 AND "discountTotal" >= 0 AND "couponDiscount" >= 0 AND
  "manualDiscount" >= 0 AND "loyaltyDiscount" >= 0 AND "taxTotal" >= 0 AND
  "serviceCharge" >= 0 AND "tipAmount" >= 0 AND "paidTotal" >= 0
);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);
