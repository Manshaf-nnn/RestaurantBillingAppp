-- Deduplicate a resubmitted order.
--
-- Placement had no idempotency key, so a double-tapped Place Order — or a retry
-- after a flaky connection — created two orders, each of which later deducted a
-- full set of ingredients. Rate limiting bounded how often that could happen; it
-- is not the same thing as making the operation idempotent.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- Partial, so the many orders keyed in by staff (which carry no key) do not all
-- collide on NULL. Postgres treats NULLs as distinct in a plain unique index,
-- but being explicit documents the intent and keeps the index small.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_restaurantId_idempotencyKey_key"
  ON "orders"("restaurantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
