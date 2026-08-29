-- Kitchen stations.
--
-- Purely additive: new tables, and nullable columns with defaults on existing
-- ones. There is deliberately NO backfill.
--
-- Whether an order is driven by its items (station mode) or cascaded down from
-- the order (the behaviour that existed before) is decided per ORDER by whether
-- any of its items has a `routedAt`. Every row that exists right now has null,
-- so every order in flight keeps its original behaviour to the end of its life,
-- and no restaurant sees any change until its owner creates a first station.

CREATE TYPE "OrderPriority" AS ENUM ('NORMAL', 'HIGH', 'URGENT');

-- ── stations ────────────────────────────────────────────────────────────────

CREATE TABLE "kitchen_stations" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "branchId"     TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "printerName"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "kitchen_stations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kitchen_stations_branchId_name_key"
  ON "kitchen_stations"("branchId", "name");
CREATE INDEX "kitchen_stations_restaurantId_branchId_isActive_idx"
  ON "kitchen_stations"("restaurantId", "branchId", "isActive");

ALTER TABLE "kitchen_stations"
  ADD CONSTRAINT "kitchen_stations_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "kitchen_stations_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "kitchen_station_staff" (
  "id"        TEXT NOT NULL,
  "stationId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kitchen_station_staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kitchen_station_staff_stationId_userId_key"
  ON "kitchen_station_staff"("stationId", "userId");
CREATE INDEX "kitchen_station_staff_userId_idx" ON "kitchen_station_staff"("userId");

ALTER TABLE "kitchen_station_staff"
  ADD CONSTRAINT "kitchen_station_staff_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "kitchen_stations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "kitchen_station_staff_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── the menu mapping, per branch ────────────────────────────────────────────
--
-- On food_branches and not on foods: the same pizza can come off a dedicated
-- Pizza Station at one site and the main kitchen at another.

ALTER TABLE "food_branches"
  ADD COLUMN "stationId"         TEXT,
  ADD COLUMN "noKitchenRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "food_branches_stationId_idx" ON "food_branches"("stationId");

ALTER TABLE "food_branches"
  ADD CONSTRAINT "food_branches_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "kitchen_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── the routed item ─────────────────────────────────────────────────────────
--
-- SET NULL on the station, so retiring a station cannot orphan history — which
-- is exactly why `routedAt`, not `stationId`, is the mode predicate.

ALTER TABLE "order_items"
  ADD COLUMN "stationId"   TEXT,
  ADD COLUMN "stationName" TEXT,
  ADD COLUMN "routedAt"    TIMESTAMP(3),
  ADD COLUMN "preparingAt" TIMESTAMP(3),
  ADD COLUMN "readyAt"     TIMESTAMP(3),
  ADD COLUMN "servedAt"    TIMESTAMP(3);

CREATE INDEX "order_items_stationId_status_idx" ON "order_items"("stationId", "status");

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "kitchen_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── priority, on the order ──────────────────────────────────────────────────

ALTER TABLE "orders" ADD COLUMN "priority" "OrderPriority" NOT NULL DEFAULT 'NORMAL';
