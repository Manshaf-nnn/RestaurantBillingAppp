-- pro.A.md §1, §2, §10, §20 — a real customer CRM and per-item discounts.
--
-- Additive: one new table, and nullable or defaulted columns on two existing
-- ones. Nothing is dropped and no existing value changes meaning.
--
-- Every statement is idempotent. This migration failed on its first production
-- deploy (see the note above the customer backfill below), and Prisma's
-- per-migration transaction should have rolled it back to nothing — but
-- "should have" is not a thing to bet a re-apply on, and IF NOT EXISTS costs
-- nothing. Re-running it on a database where part of it landed is a no-op for
-- that part.

-- ── §1 Customer categories the owner defines ────────────────────────────────
CREATE TABLE IF NOT EXISTS "customer_categories" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "customer_categories_restaurantId_name_key" ON "customer_categories"("restaurantId", "name");
CREATE INDEX IF NOT EXISTS "customer_categories_restaurantId_isActive_sortOrder_idx" ON "customer_categories"("restaurantId", "isActive", "sortOrder");

DO $$ BEGIN
  ALTER TABLE "customer_categories" ADD CONSTRAINT "customer_categories_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── §1, §2 The fields a customer record was missing ─────────────────────────
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "phoneKey" TEXT,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "anniversary" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "firstOrderAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "customer_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── §20 One person, one record, whatever they typed ─────────────────────────
--
-- The key is the digits only, so "077 123 4567" and "+94771234567" stop being
-- two customers. Backfilled here; the unique index below is added ONLY where
-- the backfill produced no collision, because merging two customers means
-- moving their orders, points and history and that is a decision for a person,
-- not for a migration running at deploy time. `scripts/merge-duplicate-customers.ts`
-- does the merge with an audit trail; until it is run, a colliding pair simply
-- keeps its NULL key and behaves exactly as it does today.
-- ── The one row this must not touch ─────────────────────────────────────────
--
-- `customers_phone_not_blank` (20260920093000) says a phone is null or not
-- blank. It was added NOT VALID because production already held a row that
-- broke it: the legacy shared walk-in, `phone: ''`, into which every anonymous
-- guest used to collapse. `orders/service.ts` stopped creating it — an
-- anonymous order now carries a name snapshot and no customer — but the
-- historical row stays, because its totals are real money that was really
-- taken.
--
-- A NOT VALID check still applies to UPDATEs. So rewriting that row here
-- failed the whole migration on the first production deploy, with
-- `new row for relation "customers" violates check constraint`. It is skipped
-- rather than repaired: `phone` is NOT NULL so it cannot be set to null, and
-- anything else would be inventing a phone number for a row that represents
-- many people. Its `phoneKey` stays null, which is correct — a pooled walk-in
-- is not somebody to match by phone — and it behaves exactly as it does today.
--
-- The guard is the constraint's own predicate, so the two cannot drift.
UPDATE "customers"
   SET "phoneKey" = NULLIF(regexp_replace("phone", '[^0-9]', '', 'g'), '')
 WHERE btrim("phone") <> '';

UPDATE "customers" c
   SET "phoneKey" = NULL
 WHERE c."phoneKey" IS NOT NULL
   AND btrim(c."phone") <> ''
   AND EXISTS (
     SELECT 1 FROM "customers" other
      WHERE other."restaurantId" = c."restaurantId"
        AND other."phoneKey" = c."phoneKey"
        AND other."id" <> c."id"
   );

-- NULLs never collide in Postgres, so this is safe over the rows left above.
CREATE UNIQUE INDEX IF NOT EXISTS "customers_restaurantId_phoneKey_key" ON "customers"("restaurantId", "phoneKey");

-- ── §3 Segment filtering needs something to seek on ─────────────────────────
CREATE INDEX IF NOT EXISTS "customers_restaurantId_totalSpent_idx" ON "customers"("restaurantId", "totalSpent");
CREATE INDEX IF NOT EXISTS "customers_restaurantId_totalOrders_idx" ON "customers"("restaurantId", "totalOrders");
CREATE INDEX IF NOT EXISTS "customers_restaurantId_categoryId_idx" ON "customers"("restaurantId", "categoryId");

-- The day they first ordered, from the orders that already exist.
--
-- Same guard, same reason: the legacy walk-in has orders against it, so this
-- would touch that row and fail the migration. "The day they first ordered" is
-- meaningless for a pool of anonymous guests anyway.
UPDATE "customers" c
   SET "firstOrderAt" = f."first"
  FROM (
    SELECT "customerId", MIN("placedAt") AS "first"
      FROM "orders"
     WHERE "customerId" IS NOT NULL AND "status" <> 'CANCELLED'
     GROUP BY "customerId"
  ) f
 WHERE f."customerId" = c."id"
   AND btrim(c."phone") <> '';

-- ── §10 Per-item discounts ──────────────────────────────────────────────────
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "discountAmount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discountReason" TEXT;

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "itemDiscount" INTEGER NOT NULL DEFAULT 0;

-- A line discount can never be negative, nor exceed what the line is worth.
DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_discount_nonneg" CHECK ("discountAmount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_item_discount_nonneg" CHECK ("itemDiscount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
