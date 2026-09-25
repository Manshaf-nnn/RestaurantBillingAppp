-- Menu codes, delivery locations, and the offers panel.
--
-- Three unrelated-looking additions that share one property: every one of them
-- is a thing the OWNER writes and the guest or the waiter only reads. Nothing
-- here computes, prices or moves stock, so nothing here can disagree with the
-- ledger. All additive, all nullable or defaulted.
--
-- ── 1. A dish can have the owner's own code ─────────────────────────────────
--
-- Staff who know the menu by its printed numbers can type "B12" instead of
-- spelling a dish name into a search box. Optional, and unique per restaurant
-- when set, because a code you look a dish up BY has to name one dish.
--
-- Many dishes will have no code and that is the ordinary case: Postgres treats
-- NULLs as distinct in a unique index, so a partial index is not needed and a
-- thousand null codes do not collide. The same shape `inventory_items.sku`
-- has used since it was added.

ALTER TABLE "foods" ADD COLUMN IF NOT EXISTS "code" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "foods_restaurantId_code_key"
  ON "foods" ("restaurantId", "code");

-- ── 2. Where a delivery goes ────────────────────────────────────────────────
--
-- No map and no geocoder, on purpose. A campus delivery goes to one of perhaps
-- twenty places everybody already names the same way, so the owner writes the
-- list and the guest picks. A free-text address box would collect twenty
-- spellings of "boys hostel" and hand the rider a different one each time.
--
-- `categoryId` null means the location is offered to everyone; set, and only
-- guests who picked that customer category see it. That is what lets "Boys
-- Hostel" and "Girls Hostel" be offered to Campus Student and not to the
-- public, out of one list.

CREATE TABLE IF NOT EXISTS "delivery_locations" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "branchId"     TEXT,
  "name"         TEXT NOT NULL,
  "groupName"    TEXT,
  "note"         TEXT,
  "categoryId"   TEXT,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_locations_pkey" PRIMARY KEY ("id")
);

-- One name per branch: two "Villa 1"s in one picker is a mis-delivery.
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_locations_restaurantId_branchId_name_key"
  ON "delivery_locations" ("restaurantId", "branchId", "name");
CREATE INDEX IF NOT EXISTS "delivery_locations_restaurantId_isActive_sortOrder_idx"
  ON "delivery_locations" ("restaurantId", "isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "delivery_locations_categoryId_idx"
  ON "delivery_locations" ("categoryId");

DO $$
BEGIN
  ALTER TABLE "delivery_locations"
    ADD CONSTRAINT "delivery_locations_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "delivery_locations"
    ADD CONSTRAINT "delivery_locations_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "delivery_locations"
    ADD CONSTRAINT "delivery_locations_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "customer_categories"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. The order records where it went ──────────────────────────────────────
--
-- The id for reporting — "how many went to the Girls Hostel last month" — and
-- the NAME because the id cannot answer that once a location is renamed or
-- retired. The same reasoning `orders.tableLabel` already carries: a past order
-- is a record of what happened, and what happened was that it went to a place
-- called that. SET NULL so retiring a location never orphans its history.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveryLocationId"   TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveryLocationName" TEXT;

CREATE INDEX IF NOT EXISTS "orders_deliveryLocationId_idx"
  ON "orders" ("deliveryLocationId");

DO $$
BEGIN
  ALTER TABLE "orders"
    ADD CONSTRAINT "orders_deliveryLocationId_fkey"
    FOREIGN KEY ("deliveryLocationId") REFERENCES "delivery_locations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. What a QR code asks for, and what it shows ───────────────────────────
--
-- `askLocation` off by default, so every code that exists today behaves exactly
-- as it does today. `requireLocation` defaults true because a delivery with
-- nowhere to go is not an order, it is a phone call waiting to happen — but it
-- is separable, since a code may want to offer a location and still let
-- somebody collect.
--
-- `offerNote` is the owner's own words in the offers panel, beside the live
-- coupons rather than instead of them. `showOffers` already exists and already
-- gates the panel; it has been stored and never read since it was added, which
-- is the bug this release fixes rather than a new setting.

ALTER TABLE "qr_experiences" ADD COLUMN IF NOT EXISTS "askLocation"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "qr_experiences" ADD COLUMN IF NOT EXISTS "requireLocation" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "qr_experiences" ADD COLUMN IF NOT EXISTS "offerNote"       TEXT;
