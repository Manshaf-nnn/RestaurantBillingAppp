-- bugfix.md D2, D16, D17, D19, M20 — money history survives a user delete,
-- and the invariants the code enforces are now enforced by the database too.
--
-- A drawer session cascaded from the user who opened it, and a handover from
-- either party: one user delete would have erased cash-reconciliation history.
-- RESTRICT, like every other financial relation here.
--
-- Every CHECK is added NOT VALID and then validated best-effort: a violation
-- in historical rows leaves the constraint in place for every NEW write and
-- raises a NOTICE naming it, rather than failing the deploy. The integrity
-- checker reports the historical rows.

DO $$
DECLARE existing text;
BEGIN
  SELECT c.conname INTO existing
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = '"cash_drawer_sessions"'::regclass AND c.contype = 'f' AND a.attname = 'openedById'
   LIMIT 1;
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "cash_drawer_sessions" DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_openedById_fkey"
    FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
DECLARE existing text;
BEGIN
  SELECT c.conname INTO existing
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = '"cash_handovers"'::regclass AND c.contype = 'f' AND a.attname = 'fromSessionId'
   LIMIT 1;
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "cash_handovers" DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_fromSessionId_fkey"
    FOREIGN KEY ("fromSessionId") REFERENCES "cash_drawer_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
DECLARE existing text;
BEGIN
  SELECT c.conname INTO existing
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = '"cash_handovers"'::regclass AND c.contype = 'f' AND a.attname = 'fromUserId'
   LIMIT 1;
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "cash_handovers" DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_fromUserId_fkey"
    FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
DECLARE existing text;
BEGIN
  SELECT c.conname INTO existing
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = '"cash_handovers"'::regclass AND c.contype = 'f' AND a.attname = 'toUserId'
   LIMIT 1;
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "cash_handovers" DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_toUserId_fkey"
    FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

-- The one total everything downstream reads was the one column the existing
-- orders_money_nonneg constraint left out.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_grand_total_nonneg') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_grand_total_nonneg" CHECK ("grandTotal" >= 0) NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_grand_total_nonneg";
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'orders_grand_total_nonneg: existing rows violate it; left NOT VALID (new writes are still checked). Run the integrity checker.';
END $$;

-- "discountTotal is their sum, always" — the schema says so; now the table does.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_split') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_split" CHECK ("discountTotal" = "couponDiscount" + "manualDiscount") NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_discount_split";
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'orders_discount_split: existing rows violate it; left NOT VALID (new writes are still checked). Run the integrity checker.';
END $$;

-- allowNegativeStock is about on-hand quantity; reserved and in-transit are
-- never legitimately below zero.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_stock_reserved_transit_nonneg') THEN
    ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_reserved_transit_nonneg" CHECK ("reserved" >= 0 AND "inTransit" >= 0) NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_stock" VALIDATE CONSTRAINT "inventory_stock_reserved_transit_nonneg";
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'inventory_stock_reserved_transit_nonneg: existing rows violate it; left NOT VALID (new writes are still checked). Run the integrity checker.';
END $$;


-- '' was a pooled fake customer that collected every walk-in's loyalty
-- points. A walk-in now simply has no customer row (the order path already
-- does this). The historical '' rows stay — the unique index already allows
-- only one per restaurant — and no new one can be made.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_phone_not_blank') THEN
    ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_not_blank" CHECK ("phone" IS NULL OR btrim("phone") <> '') NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_phone_not_blank";
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'customers_phone_not_blank: existing rows violate it; left NOT VALID (new writes are still checked). Run the integrity checker.';
END $$;


-- An approval is consumed once (owner decision, 2026-09-13).
ALTER TABLE "approval_requests" ADD COLUMN "consumedAt" TIMESTAMP(3);

-- One default branch per restaurant. Demote all but the oldest live default
-- first, so the index can be created on a table that already obeys it.
UPDATE "branches" b
   SET "isDefault" = false
  FROM (
    SELECT id, row_number() OVER (PARTITION BY "restaurantId" ORDER BY "createdAt" ASC) AS rn
      FROM "branches"
     WHERE "isDefault" = true AND "deletedAt" IS NULL
  ) ranked
 WHERE b.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "branches_one_default_per_restaurant"
  ON "branches"("restaurantId") WHERE "isDefault" = true AND "deletedAt" IS NULL;
