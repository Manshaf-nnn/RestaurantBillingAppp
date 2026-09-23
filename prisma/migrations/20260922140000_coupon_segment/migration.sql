-- pro.A.md §4 — a discount aimed at a group of customers.
--
-- A campaign is a coupon with a saved filter on it, evaluated against the
-- customer the order belongs to. Null means everybody, which is what every
-- existing coupon means, so nothing changes for them.
ALTER TABLE "coupons" ADD COLUMN "segment" JSONB;
