-- Retire the shared walk-in identity (AUDIT.md C2).
--
-- Every blank phone number used to upsert into ONE Customer row per restaurant
-- keyed phone = '' . Its loyalty points were the pooled points of every
-- anonymous guest ever served, and anyone ordering without a phone number
-- could spend them. The code no longer creates or reads these rows; this
-- detaches history from them so nothing can credit or spend against the pool
-- again (cancelling an old walk-in order used to put points back INTO it).
--
-- The rows themselves stay: they are the record that this happened, and
-- deleting them would SetNull coupon redemptions that legitimately happened.
UPDATE orders
SET "customerId" = NULL
WHERE "customerId" IN (SELECT id FROM customers WHERE btrim(phone) = '');

UPDATE customers
SET "loyaltyPoints" = 0,
    "totalOrders"   = 0
WHERE btrim(phone) = '';
