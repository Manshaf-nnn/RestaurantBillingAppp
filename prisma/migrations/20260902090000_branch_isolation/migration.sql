-- Branch isolation: a per-branch menu, and a branch on every table and order.
--
-- Three parts, in order: create the join table, back-fill it and the two
-- columns, and only then tighten the constraints. The back-fill runs BEFORE the
-- NOT NULLs so nothing is left stranded — and it must, because 426 of the 434
-- orders in production carry no branch at all.

-- ── 1. The per-branch menu ──────────────────────────────────────────────────
--
-- A join table, not a copy of the dish per branch. Duplicating would fork the
-- recipe, the photo, the variant groups and the sales history; one Food stays
-- the master and only what differs per site lives here.

CREATE TABLE "food_branches" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "foodId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "price" INTEGER,
    "discountPrice" INTEGER,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_branches_pkey" PRIMARY KEY ("id")
);

-- A dish is listed at a branch once. Both columns are non-null, so unlike
-- inventory_stock this needs no partial index.
CREATE UNIQUE INDEX "food_branches_foodId_branchId_key" ON "food_branches"("foodId", "branchId");
CREATE INDEX "food_branches_restaurantId_branchId_isAvailable_idx"
    ON "food_branches"("restaurantId", "branchId", "isAvailable");
-- Prisma's nested include emits `WHERE branchId IN (...)` with no tenant
-- predicate; without this the guest menu scans the whole shared table.
CREATE INDEX "food_branches_branchId_idx" ON "food_branches"("branchId");

ALTER TABLE "food_branches" ADD CONSTRAINT "food_branches_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "food_branches" ADD CONSTRAINT "food_branches_foodId_fkey"
    FOREIGN KEY ("foodId") REFERENCES "foods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "food_branches" ADD CONSTRAINT "food_branches_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. Every restaurant needs a branch before anything can point at one ─────
--
-- A restaurant with no branch at all would fail the NOT NULLs below. In
-- practice `ensureDefaultBranch` creates one on demand, but a tenant that has
-- never opened an inventory screen may have none, so make it certain here.

INSERT INTO "branches" ("id", "restaurantId", "name", "code", "type", "isDefault", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, r."id", 'Main', 'MAIN', 'BRANCH', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "restaurants" r
WHERE NOT EXISTS (
    SELECT 1 FROM "branches" b WHERE b."restaurantId" = r."id" AND b."deletedAt" IS NULL
);

-- Exactly one default per restaurant. If none was ever marked, promote the
-- oldest — the columns below resolve through it.
UPDATE "branches" b
SET "isDefault" = true
WHERE b."isDefault" = false
  AND b."deletedAt" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "branches" d
      WHERE d."restaurantId" = b."restaurantId" AND d."deletedAt" IS NULL AND d."isDefault" = true
  )
  AND b."id" = (
      SELECT o."id" FROM "branches" o
      WHERE o."restaurantId" = b."restaurantId" AND o."deletedAt" IS NULL
      ORDER BY o."createdAt" ASC LIMIT 1
  );

-- ── 3. Back-fill the menu: every dish at every branch it already served ─────
--
-- Existing dishes were restaurant-wide, so they must stay available everywhere
-- or every menu empties the moment this ships. `price` stays null, meaning
-- "use the dish's own price" — nothing is copied, so a later price change still
-- reaches every branch that has not deliberately overridden it.

INSERT INTO "food_branches" ("id", "restaurantId", "foodId", "branchId", "isAvailable", "updatedAt")
SELECT gen_random_uuid()::text, f."restaurantId", f."id", b."id", true, CURRENT_TIMESTAMP
FROM "foods" f
JOIN "branches" b ON b."restaurantId" = f."restaurantId" AND b."deletedAt" IS NULL
WHERE f."deletedAt" IS NULL
ON CONFLICT ("foodId", "branchId") DO NOTHING;

-- ── 4. Tables belong to a branch ───────────────────────────────────────────

UPDATE "restaurant_tables" t
SET "branchId" = (
    SELECT b."id" FROM "branches" b
    WHERE b."restaurantId" = t."restaurantId" AND b."deletedAt" IS NULL
    ORDER BY b."isDefault" DESC, b."createdAt" ASC
    LIMIT 1
)
WHERE t."branchId" IS NULL;

-- The old key was [restaurantId, number], so Main and Kandy could not both have
-- a "Table 1". Numbers restart per branch now.
DROP INDEX IF EXISTS "restaurant_tables_restaurantId_number_key";
ALTER TABLE "restaurant_tables" ALTER COLUMN "branchId" SET NOT NULL;
CREATE UNIQUE INDEX "restaurant_tables_restaurantId_branchId_number_key"
    ON "restaurant_tables"("restaurantId", "branchId", "number");

-- The FK was created nullable with no explicit action; restate it now that the
-- column is required. RESTRICT, because deleting a branch out from under a
-- table would orphan its orders.
ALTER TABLE "restaurant_tables" DROP CONSTRAINT IF EXISTS "restaurant_tables_branchId_fkey";
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 5. Orders belong to a branch ───────────────────────────────────────────
--
-- Prefer the branch of the table the order was taken at — that is the truthful
-- answer where one exists — and fall back to the restaurant's default.

UPDATE "orders" o
SET "branchId" = t."branchId"
FROM "restaurant_tables" t
WHERE o."tableId" = t."id" AND o."branchId" IS NULL;

UPDATE "orders" o
SET "branchId" = (
    SELECT b."id" FROM "branches" b
    WHERE b."restaurantId" = o."restaurantId" AND b."deletedAt" IS NULL
    ORDER BY b."isDefault" DESC, b."createdAt" ASC
    LIMIT 1
)
WHERE o."branchId" IS NULL;

ALTER TABLE "orders" ALTER COLUMN "branchId" SET NOT NULL;

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_branchId_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
