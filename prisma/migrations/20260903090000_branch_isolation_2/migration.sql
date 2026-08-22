-- Strict branch isolation, part two.
--
-- Part one gave orders, tables and per-branch stock a required branch. This
-- finishes the job for the operational records that were left behind, and it
-- fixes the mirror-image failure: a filter of `branchId = X` silently hides
-- every row where the column is NULL, which is why an owner who picked a
-- branch watched their own history disappear.
--
-- Order matters. Every column is added, then back-filled, and only then
-- constrained — the same shape as 20260902090000_branch_isolation, and for the
-- same reason: a SET NOT NULL against a table with one stranded row fails the
-- whole migration.
--
-- ── What does NOT become required, and why ─────────────────────────────────
--
-- Four models keep a nullable branch because NULL is a true statement there,
-- not a missing value:
--
--   audit_logs           its own restaurantId is nullable — platform-level
--                        rows exist and belong to no site
--   coupons              "20% off, every branch" is an ordinary promotion
--   branch_instructions  NULL already means "tell every location"
--   notifications        a group-wide announcement is a real thing
--
-- Forcing those onto the default branch would not preserve information, it
-- would invent it — Main Branch would appear to own every audit entry in the
-- business. They are handled in the queries instead, which include NULL rather
-- than filtering it away. See `atBranchOrGroup` in src/lib/branch-filter.ts.

-- ── 1. Every restaurant has a branch, and exactly one default ──────────────
--
-- Repeated from part one rather than assumed: a tenant created since then, or
-- one that has never opened an inventory screen, may still have none, and
-- every back-fill below resolves through the default.

INSERT INTO "branches" ("id", "restaurantId", "name", "code", "type", "isDefault", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, r."id", 'Main', 'MAIN', 'BRANCH', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "restaurants" r
WHERE NOT EXISTS (
    SELECT 1 FROM "branches" b WHERE b."restaurantId" = r."id" AND b."deletedAt" IS NULL
);

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

-- ── 2. The three new columns ───────────────────────────────────────────────

ALTER TABLE "shift_notes"      ADD COLUMN "branchId" TEXT;
ALTER TABLE "notifications"    ADD COLUMN "branchId" TEXT;
ALTER TABLE "purchase_returns" ADD COLUMN "branchId" TEXT;

-- ── 3. Back-fill ───────────────────────────────────────────────────────────
--
-- Each table gets the most truthful source available before falling back to
-- the default. A guess is only made where nothing else knows.

-- Handover notes: the author's own location.
UPDATE "shift_notes" n
SET "branchId" = u."branchId"
FROM "users" u
WHERE n."authorId" = u."id" AND u."branchId" IS NOT NULL AND n."branchId" IS NULL;

-- Notifications: deliberately NOT back-filled. Every existing one predates
-- branch targeting, and calling them all Main Branch's would be a fabrication.
-- NULL reads as "everyone", which is how they have behaved all along.

-- Returns: the branch of the purchase they came from.
UPDATE "purchase_returns" r
SET "branchId" = p."branchId"
FROM "purchases" p
WHERE r."purchaseId" = p."id" AND p."branchId" IS NOT NULL AND r."branchId" IS NULL;

-- Goods receipts: the branch of their purchase order.
UPDATE "goods_receipts" g
SET "branchId" = p."branchId"
FROM "purchases" p
WHERE g."purchaseId" = p."id" AND p."branchId" IS NOT NULL AND g."branchId" IS NULL;

-- Purchases: the branch of a receipt already booked against them. This runs
-- after the line above on purpose — a purchase with a branch has already given
-- it to its receipts, so only the reverse direction is left to learn.
UPDATE "purchases" p
SET "branchId" = g."branchId"
FROM "goods_receipts" g
WHERE g."purchaseId" = p."id" AND g."branchId" IS NOT NULL AND p."branchId" IS NULL;

-- Anything holding a storage location knows its branch through that shelf.
UPDATE "stock_movements" m
SET "branchId" = s."branchId"
FROM "storage_locations" s
WHERE m."locationId" = s."id" AND s."branchId" IS NOT NULL AND m."branchId" IS NULL;

UPDATE "stock_batches" b
SET "branchId" = s."branchId"
FROM "storage_locations" s
WHERE b."locationId" = s."id" AND s."branchId" IS NOT NULL AND b."branchId" IS NULL;

UPDATE "wastage_records" w
SET "branchId" = s."branchId"
FROM "storage_locations" s
WHERE w."locationId" = s."id" AND s."branchId" IS NOT NULL AND w."branchId" IS NULL;

UPDATE "stock_counts" c
SET "branchId" = s."branchId"
FROM "storage_locations" s
WHERE c."locationId" = s."id" AND s."branchId" IS NOT NULL AND c."branchId" IS NULL;

-- Cash drawers: the cashier's own location.
UPDATE "cash_drawer_sessions" d
SET "branchId" = u."branchId"
FROM "users" u
WHERE d."openedById" = u."id" AND u."branchId" IS NOT NULL AND d."branchId" IS NULL;

-- Everything still unplaced goes to the default. This is the only guess in the
-- migration, and it is the one the owner chose: a legacy row on the default
-- branch is visible and correctable, where a NULL row is invisible.
UPDATE "shift_notes"          SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "shift_notes"."restaurantId"          AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "purchase_returns"     SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "purchase_returns"."restaurantId"     AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "goods_receipts"       SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "goods_receipts"."restaurantId"       AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "purchases"            SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "purchases"."restaurantId"            AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "stock_movements"      SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "stock_movements"."restaurantId"      AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "stock_batches"        SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "stock_batches"."restaurantId"        AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "wastage_records"      SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "wastage_records"."restaurantId"      AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "stock_counts"         SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "stock_counts"."restaurantId"         AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "cash_drawer_sessions" SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "cash_drawer_sessions"."restaurantId" AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;
UPDATE "storage_locations"    SET "branchId" = (SELECT b."id" FROM "branches" b WHERE b."restaurantId" = "storage_locations"."restaurantId"    AND b."deletedAt" IS NULL ORDER BY b."isDefault" DESC, b."createdAt" ASC LIMIT 1) WHERE "branchId" IS NULL;

-- ── 4. Constrain ───────────────────────────────────────────────────────────

ALTER TABLE "shift_notes"          ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "purchase_returns"     ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "goods_receipts"       ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "purchases"            ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "stock_movements"      ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "stock_batches"        ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "wastage_records"      ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "stock_counts"         ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "cash_drawer_sessions" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "storage_locations"    ALTER COLUMN "branchId" SET NOT NULL;

-- RESTRICT everywhere the column is now required. SET NULL is not available to
-- a NOT NULL column, and RESTRICT is the behaviour we want regardless: a
-- location holding history must be refused, not silently detached from it.
-- The application says so in words first — see `assertLocationRemovable` — and
-- this is the backstop underneath it.

ALTER TABLE "shift_notes"          ADD CONSTRAINT "shift_notes_branchId_fkey"          FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_returns"     ADD CONSTRAINT "purchase_returns_branchId_fkey"     FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications"        ADD CONSTRAINT "notifications_branchId_fkey"        FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "goods_receipts"       DROP CONSTRAINT IF EXISTS "goods_receipts_branchId_fkey";
ALTER TABLE "goods_receipts"       ADD CONSTRAINT "goods_receipts_branchId_fkey"       FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchases"            DROP CONSTRAINT IF EXISTS "purchases_branchId_fkey";
ALTER TABLE "purchases"            ADD CONSTRAINT "purchases_branchId_fkey"            FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements"      DROP CONSTRAINT IF EXISTS "stock_movements_branchId_fkey";
ALTER TABLE "stock_movements"      ADD CONSTRAINT "stock_movements_branchId_fkey"      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_batches"        DROP CONSTRAINT IF EXISTS "stock_batches_branchId_fkey";
ALTER TABLE "stock_batches"        ADD CONSTRAINT "stock_batches_branchId_fkey"        FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wastage_records"      DROP CONSTRAINT IF EXISTS "wastage_records_branchId_fkey";
ALTER TABLE "wastage_records"      ADD CONSTRAINT "wastage_records_branchId_fkey"      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_counts"         DROP CONSTRAINT IF EXISTS "stock_counts_branchId_fkey";
ALTER TABLE "stock_counts"         ADD CONSTRAINT "stock_counts_branchId_fkey"         FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_drawer_sessions" DROP CONSTRAINT IF EXISTS "cash_drawer_sessions_branchId_fkey";
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "storage_locations"    DROP CONSTRAINT IF EXISTS "storage_locations_branchId_fkey";
ALTER TABLE "storage_locations"    ADD CONSTRAINT "storage_locations_branchId_fkey"    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 5. Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "shift_notes_restaurantId_branchId_resolved_createdAt_idx"
    ON "shift_notes"("restaurantId", "branchId", "resolved", "createdAt");
CREATE INDEX IF NOT EXISTS "notifications_restaurantId_branchId_createdAt_idx"
    ON "notifications"("restaurantId", "branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "purchase_returns_restaurantId_branchId_createdAt_idx"
    ON "purchase_returns"("restaurantId", "branchId", "createdAt");
