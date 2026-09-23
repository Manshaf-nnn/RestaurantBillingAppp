-- ar.md — QR Menu & Customer Access Control Center.
--
-- A configuration layer over the systems that already exist: the menu, the
-- CRM, the discount engine, loyalty and orders are all untouched. What is
-- added here is somewhere to keep per-code configuration, somewhere to keep
-- the answers to the owner's own questions, and the attribution that links an
-- order back to the code that produced it.
--
-- Additive. No column is dropped, no row is rewritten, and no table carrying a
-- NOT VALID check is touched. Every statement is idempotent, so re-running it
-- on a database where part of it landed is a no-op for that part.

-- ── §3, §5, §9, §10. The vocabulary ────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "QrExperienceType" AS ENUM ('ORDERING', 'MENU_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "QrMenuMode" AS ENUM ('ALL', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "QrFieldType" AS ENUM ('TEXT', 'PHONE', 'EMAIL', 'DATE', 'NUMBER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "QrFieldRule" AS ENUM ('HIDDEN', 'OPTIONAL', 'REQUIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── §1, §4, §13. The experience itself ─────────────────────────────────────
--
-- Defaults are chosen so a row created with nothing but a name and a branch
-- reproduces the existing QR behaviour exactly (§2, §21): ordering, the whole
-- menu, nobody asked for anything.
CREATE TABLE IF NOT EXISTS "qr_experiences" (
  "id"                  TEXT NOT NULL,
  "restaurantId"        TEXT NOT NULL,
  "branchId"            TEXT NOT NULL,
  "publicId"            TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "description"         TEXT,
  "type"                "QrExperienceType" NOT NULL DEFAULT 'ORDERING',
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "menuMode"            "QrMenuMode" NOT NULL DEFAULT 'ALL',
  "menuCategoryIds"     JSONB,
  "menuFoodIds"         JSONB,
  "identifyCustomer"    BOOLEAN NOT NULL DEFAULT false,
  "askCustomerCategory" BOOLEAN NOT NULL DEFAULT false,
  "customerCategoryIds" JSONB,
  "showSearch"          BOOLEAN NOT NULL DEFAULT true,
  "showPrices"          BOOLEAN NOT NULL DEFAULT true,
  "showOffers"          BOOLEAN NOT NULL DEFAULT true,
  "showLoyalty"         BOOLEAN NOT NULL DEFAULT true,
  "openCount"           INTEGER NOT NULL DEFAULT 0,
  "lastOpenedAt"        TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qr_experiences_pkey" PRIMARY KEY ("id")
);

-- Safe on an existing database: the table is created in this same migration,
-- so there are no rows to collide.
CREATE UNIQUE INDEX IF NOT EXISTS "qr_experiences_publicId_key"
  ON "qr_experiences"("publicId");
CREATE INDEX IF NOT EXISTS "qr_experiences_restaurantId_branchId_isActive_idx"
  ON "qr_experiences"("restaurantId", "branchId", "isActive");

DO $$ BEGIN
  ALTER TABLE "qr_experiences"
    ADD CONSTRAINT "qr_experiences_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "qr_experiences"
    ADD CONSTRAINT "qr_experiences_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── §5, §7, §9. What a guest is asked ──────────────────────────────────────
--
-- `categoryId` null = asked of everyone; set = asked only once that customer
-- category is chosen. One column, three sections of the spec.
CREATE TABLE IF NOT EXISTS "qr_experience_fields" (
  "id"           TEXT NOT NULL,
  "experienceId" TEXT NOT NULL,
  "key"          TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "type"         "QrFieldType" NOT NULL DEFAULT 'TEXT',
  "rule"         "QrFieldRule" NOT NULL DEFAULT 'OPTIONAL',
  "categoryId"   TEXT,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "isBuiltIn"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qr_experience_fields_pkey" PRIMARY KEY ("id")
);

-- The same field may be asked of everyone AND, differently, of one category
-- ("phone optional generally, required for VIP"), so the category is part of
-- the key. NULLs are distinct in Postgres, which is what makes that work.
CREATE UNIQUE INDEX IF NOT EXISTS "qr_experience_fields_experienceId_key_categoryId_key"
  ON "qr_experience_fields"("experienceId", "key", "categoryId");
CREATE INDEX IF NOT EXISTS "qr_experience_fields_experienceId_sortOrder_idx"
  ON "qr_experience_fields"("experienceId", "sortOrder");
CREATE INDEX IF NOT EXISTS "qr_experience_fields_categoryId_idx"
  ON "qr_experience_fields"("categoryId");

DO $$ BEGIN
  ALTER TABLE "qr_experience_fields"
    ADD CONSTRAINT "qr_experience_fields_experienceId_fkey"
    FOREIGN KEY ("experienceId") REFERENCES "qr_experiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "qr_experience_fields"
    ADD CONSTRAINT "qr_experience_fields_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "customer_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── §8, §9, §23. The answers, and where the customer came from ─────────────
--
-- `profile` is Json because §23 needs these shown on the profile and nothing
-- filters or aggregates on them. `sourceQrExperienceId` is written once, on
-- insert, so "new customers from this code" is a count rather than a guess.
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "profile"              JSONB,
  ADD COLUMN IF NOT EXISTS "sourceQrExperienceId" TEXT;

CREATE INDEX IF NOT EXISTS "customers_restaurantId_sourceQrExperienceId_idx"
  ON "customers"("restaurantId", "sourceQrExperienceId");

DO $$ BEGIN
  ALTER TABLE "customers"
    ADD CONSTRAINT "customers_sourceQrExperienceId_fkey"
    FOREIGN KEY ("sourceQrExperienceId") REFERENCES "qr_experiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── §15, §24. Which code produced this order ───────────────────────────────
--
-- Attribution only. The order is an ordinary TableFlow order and travels the
-- same cashier → kitchen → billing → reporting path as every other.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "qrExperienceId" TEXT;

CREATE INDEX IF NOT EXISTS "orders_restaurantId_qrExperienceId_idx"
  ON "orders"("restaurantId", "qrExperienceId");

DO $$ BEGIN
  ALTER TABLE "orders"
    ADD CONSTRAINT "orders_qrExperienceId_fkey"
    FOREIGN KEY ("qrExperienceId") REFERENCES "qr_experiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── §11, §12. An offer that belongs to one code ────────────────────────────
--
-- Null means everywhere, which is every coupon that exists today. One column
-- and one check inside the existing `evaluate()`; no second discount engine.
ALTER TABLE "coupons"
  ADD COLUMN IF NOT EXISTS "qrExperienceId" TEXT;

DO $$ BEGIN
  ALTER TABLE "coupons"
    ADD CONSTRAINT "coupons_qrExperienceId_fkey"
    FOREIGN KEY ("qrExperienceId") REFERENCES "qr_experiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
