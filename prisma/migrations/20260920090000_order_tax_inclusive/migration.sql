-- bugfix.md M10 / M1 — a bill remembers whether its prices contained tax.
--
-- `orders` already snapshot taxRateBps and serviceChargeBps at placement, and
-- never the inclusive/exclusive rule those rates were applied under. Every
-- recompute read the restaurant's CURRENT setting, so flipping the switch in
-- Settings silently repriced every open bill — and the journal could not tell
-- a tax-inclusive sale from an exclusive one, which is why it plugged the gap
-- into "rounding" on every one.
--
-- The backfill is the restaurant's setting today: the only source there is,
-- and exactly what the system already believed about each bill.

ALTER TABLE "orders" ADD COLUMN "taxInclusive" BOOLEAN NOT NULL DEFAULT false;

UPDATE "orders" o
   SET "taxInclusive" = true
  FROM "restaurants" r
 WHERE r."id" = o."restaurantId" AND r."taxInclusive" = true;
