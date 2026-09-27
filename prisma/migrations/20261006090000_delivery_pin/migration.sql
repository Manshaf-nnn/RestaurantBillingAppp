-- The four digits a customer reads out at the door.
--
-- Additive and nullable: every order that already exists has no PIN, which is
-- correct — they were placed before the handover check existed and must stay
-- completable by the ordinary status route. Only orders placed from here on
-- carry one, and only DELIVERY ones.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveryPin" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveryPinAttempts" INTEGER NOT NULL DEFAULT 0;
