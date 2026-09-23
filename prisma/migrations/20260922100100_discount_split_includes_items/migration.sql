-- pro.A.md §10 — the "discountTotal is their sum, always" rule learns about
-- the third component.
--
-- `orders_discount_split` asserted discountTotal = couponDiscount +
-- manualDiscount. Now that a line can carry its own discount, that sum is
-- short by `itemDiscount` and every order with one would be refused by the
-- database. The invariant itself is right and stays; it just has one more term.
--
-- Its own migration because the column it names has to exist first.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_split') THEN
    ALTER TABLE "orders" DROP CONSTRAINT "orders_discount_split";
  END IF;
END $$;

ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_split"
  CHECK ("discountTotal" = "couponDiscount" + "manualDiscount" + "itemDiscount") NOT VALID;

-- Every existing row has itemDiscount 0, so the old sum still holds and this
-- validates cleanly. Guarded anyway, exactly as the original was.
DO $$ BEGIN
  ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_discount_split";
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'orders_discount_split: existing rows violate it; left NOT VALID (new writes are still checked). Run the integrity checker.';
END $$;
