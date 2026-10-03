-- Rider pay per delivery: the rate the owner sets, and what each delivery
-- earned at the moment it was closed. Existing deliveries stay null — nobody
-- was promised anything for them.
ALTER TABLE "restaurants" ADD COLUMN "deliveryPayPerOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "deliveryPay" INTEGER;
