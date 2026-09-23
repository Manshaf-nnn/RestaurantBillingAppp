-- pro.A.md §1, §2, §10, §20 — a real customer CRM and per-item discounts.
--
-- Additive: one new table, and nullable or defaulted columns on two existing
-- ones. Nothing is dropped and no existing value changes meaning.

-- ── §1 Customer categories the owner defines ────────────────────────────────
CREATE TABLE "customer_categories" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_categories_restaurantId_name_key" ON "customer_categories"("restaurantId", "name");
CREATE INDEX "customer_categories_restaurantId_isActive_sortOrder_idx" ON "customer_categories"("restaurantId", "isActive", "sortOrder");

ALTER TABLE "customer_categories" ADD CONSTRAINT "customer_categories_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── §1, §2 The fields a customer record was missing ─────────────────────────
ALTER TABLE "customers"
  ADD COLUMN "phoneKey" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "anniversary" TIMESTAMP(3),
  ADD COLUMN "firstOrderAt" TIMESTAMP(3),
  ADD COLUMN "categoryId" TEXT;

ALTER TABLE "customers" ADD CONSTRAINT "customers_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "customer_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── §20 One person, one record, whatever they typed ─────────────────────────
--
-- The key is the digits only, so "077 123 4567" and "+94771234567" stop being
-- two customers. Backfilled here; the unique index below is added ONLY where
-- the backfill produced no collision, because merging two customers means
-- moving their orders, points and history and that is a decision for a person,
-- not for a migration running at deploy time. `scripts/merge-duplicate-customers.ts`
-- does the merge with an audit trail; until it is run, a colliding pair simply
-- keeps its NULL key and behaves exactly as it does today.
UPDATE "customers"
   SET "phoneKey" = NULLIF(regexp_replace("phone", '[^0-9]', '', 'g'), '');

UPDATE "customers" c
   SET "phoneKey" = NULL
 WHERE c."phoneKey" IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "customers" other
      WHERE other."restaurantId" = c."restaurantId"
        AND other."phoneKey" = c."phoneKey"
        AND other."id" <> c."id"
   );

-- NULLs never collide in Postgres, so this is safe over the rows left above.
CREATE UNIQUE INDEX "customers_restaurantId_phoneKey_key" ON "customers"("restaurantId", "phoneKey");

-- ── §3 Segment filtering needs something to seek on ─────────────────────────
CREATE INDEX "customers_restaurantId_totalSpent_idx" ON "customers"("restaurantId", "totalSpent");
CREATE INDEX "customers_restaurantId_totalOrders_idx" ON "customers"("restaurantId", "totalOrders");
CREATE INDEX "customers_restaurantId_categoryId_idx" ON "customers"("restaurantId", "categoryId");

-- The day they first ordered, from the orders that already exist.
UPDATE "customers" c
   SET "firstOrderAt" = f."first"
  FROM (
    SELECT "customerId", MIN("placedAt") AS "first"
      FROM "orders"
     WHERE "customerId" IS NOT NULL AND "status" <> 'CANCELLED'
     GROUP BY "customerId"
  ) f
 WHERE f."customerId" = c."id";

-- ── §10 Per-item discounts ──────────────────────────────────────────────────
ALTER TABLE "order_items"
  ADD COLUMN "discountAmount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discountReason" TEXT;

ALTER TABLE "orders"
  ADD COLUMN "itemDiscount" INTEGER NOT NULL DEFAULT 0;

-- A line discount can never be negative, nor exceed what the line is worth.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_discount_nonneg" CHECK ("discountAmount" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_item_discount_nonneg" CHECK ("itemDiscount" >= 0);
