-- Manageable units and stock categories.
--
-- Purely additive. Two new tables and one new nullable column; no existing
-- column is altered or dropped, so this is safe to apply to a live database.
--
-- StockUnit deliberately stays an enum. The conversion engine encodes facts
-- (1 kg = 1000 g) that guard every ledger row; the `units` table governs what a
-- unit is CALLED and whether it is OFFERED, never what it is worth.

CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "code" "StockUnit" NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "units_restaurantId_code_key" ON "units"("restaurantId", "code");
CREATE INDEX "units_restaurantId_isActive_idx" ON "units"("restaurantId", "isActive");

ALTER TABLE "units" ADD CONSTRAINT "units_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "inventory_categories" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_categories_restaurantId_name_key"
    ON "inventory_categories"("restaurantId", "name");
CREATE INDEX "inventory_categories_restaurantId_isActive_idx"
    ON "inventory_categories"("restaurantId", "isActive");

ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The item's link to a managed category. Nullable, and SET NULL on delete, so
-- retiring or removing a category can never orphan or destroy an item.
ALTER TABLE "inventory_items" ADD COLUMN "categoryId" TEXT;

CREATE INDEX "inventory_items_restaurantId_categoryId_idx"
    ON "inventory_items"("restaurantId", "categoryId");

ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "inventory_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Back-fill ───────────────────────────────────────────────────────────────
--
-- Every distinct category string that already exists becomes a real category,
-- and the items pointing at it are linked. Nothing typed so far is lost, and
-- nobody has to re-enter it. Case-insensitive so "Dairy" and "dairy" — which
-- free text allowed to become two silent buckets — collapse into one.

INSERT INTO "inventory_categories" ("id", "restaurantId", "name", "sortOrder", "updatedAt")
SELECT
    gen_random_uuid()::text,
    grouped."restaurantId",
    grouped."name",
    0,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (i."restaurantId", lower(trim(i."category")))
        i."restaurantId" AS "restaurantId",
        trim(i."category") AS "name"
    FROM "inventory_items" i
    WHERE i."category" IS NOT NULL AND trim(i."category") <> ''
    ORDER BY i."restaurantId", lower(trim(i."category")), i."createdAt"
) grouped
ON CONFLICT ("restaurantId", "name") DO NOTHING;

UPDATE "inventory_items" i
SET "categoryId" = c."id"
FROM "inventory_categories" c
WHERE c."restaurantId" = i."restaurantId"
  AND lower(c."name") = lower(trim(i."category"))
  AND i."category" IS NOT NULL
  AND trim(i."category") <> '';

-- Seed the nine units for every existing restaurant, so the management screen
-- is populated the first time anyone opens it rather than blank.
INSERT INTO "units" ("id", "restaurantId", "code", "name", "symbol", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text, r."id", u."code"::"StockUnit", u."name", u."symbol", u."sortOrder", CURRENT_TIMESTAMP
FROM "restaurants" r
CROSS JOIN (VALUES
    ('KG',     'Kilogram',   'kg',      10),
    ('GRAM',   'Gram',       'g',       20),
    ('LITRE',  'Litre',      'L',       30),
    ('ML',     'Millilitre', 'ml',      40),
    ('PIECE',  'Piece',      'pc',      50),
    ('DOZEN',  'Dozen',      'dozen',   60),
    ('BOX',    'Box',        'box',     70),
    ('PACK',   'Packet',     'packet',  80),
    ('BOTTLE', 'Bottle',     'bottle',  90)
) AS u("code", "name", "symbol", "sortOrder")
ON CONFLICT ("restaurantId", "code") DO NOTHING;
