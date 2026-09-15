-- bugfix.md D8 — a double-tap must not post stock or money twice.
--
-- Payment, Refund and ProductionOrder carry a clientRequestId so the request
-- that committed and then lost its response is answered with the row it made,
-- not a second one. Goods receipts, wastage and supplier payments had no such
-- key: two taps on "Receive" put the delivery in stock twice and credited the
-- supplier twice. Nullable, so nothing existing is touched; unique per
-- restaurant over non-null values, so a replay is a no-op.

ALTER TABLE "goods_receipts"    ADD COLUMN "clientRequestId" TEXT;
ALTER TABLE "wastage_records"   ADD COLUMN "clientRequestId" TEXT;
ALTER TABLE "supplier_payments" ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "goods_receipts_restaurantId_clientRequestId_key"
  ON "goods_receipts"("restaurantId", "clientRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "wastage_records_restaurantId_clientRequestId_key"
  ON "wastage_records"("restaurantId", "clientRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_payments_restaurantId_clientRequestId_key"
  ON "supplier_payments"("restaurantId", "clientRequestId");
