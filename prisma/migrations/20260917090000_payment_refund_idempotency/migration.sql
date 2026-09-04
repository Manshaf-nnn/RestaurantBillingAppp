-- Retry safety for money in and money out (production.md §2).
--
-- capturePayment and refundPayment already lock the order row FOR UPDATE, which
-- defeats two simultaneous taps. It does not defeat a retry: a request that
-- commits and then loses its response leaves the client believing nothing
-- happened, and the next attempt books a second payment (or hands the cash back
-- a second time). The client now mints one id per tender attempt and reuses it
-- across retries; these constraints are what make the replay lose.
--
-- Additive and nullable, so every existing row stays valid and the paths that
-- predate the key keep working. Postgres treats NULLs as distinct in a unique
-- index, so unkeyed rows do not collide with each other.
ALTER TABLE "payments" ADD COLUMN "clientRequestId" TEXT;
ALTER TABLE "refunds" ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "payments_restaurantId_clientRequestId_key"
    ON "payments"("restaurantId", "clientRequestId");
CREATE UNIQUE INDEX "refunds_restaurantId_clientRequestId_key"
    ON "refunds"("restaurantId", "clientRequestId");
