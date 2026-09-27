-- Cash on delivery, as a payment method.
--
-- Additive: a new enum member and one more default account. Nothing existing
-- changes meaning, and a restaurant that never takes a delivery simply never
-- uses either.
--
-- ADD VALUE cannot run inside a transaction in older Postgres, and Prisma
-- wraps each migration in one — `IF NOT EXISTS` plus a separate statement is
-- what keeps this re-runnable if the deploy retries.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'COD';
-- Every restaurant gets a "Cash on delivery" account, so the method has
-- somewhere to land the moment it is used. Owners can point COD at an
-- existing account instead from Settings; this only guarantees it is never
-- unroutable, which is what `NO_PAYMENT_DESTINATION` refuses on.
INSERT INTO "payment_accounts" ("id", "restaurantId", "code", "name", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, r.id, 'cod', 'Cash on delivery', true, now(), now()
  FROM "restaurants" r
 WHERE NOT EXISTS (
   SELECT 1 FROM "payment_accounts" a WHERE a."restaurantId" = r.id AND a."code" = 'cod'
 );
