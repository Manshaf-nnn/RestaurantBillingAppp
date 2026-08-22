-- Remember which table an order was at, even after the table is gone.
--
-- `orders.tableId` is ON DELETE SET NULL, and nothing snapshotted the number,
-- so removing a table quietly erased the table from every order ever taken at
-- it. The bill, the receipt, the orders list and the payments screen all read
-- it through the relation, so all of them went blank at once.
--
-- The back-fill reads the current relation, which is the best available answer:
-- rows whose table has already been deleted cannot be recovered and stay null,
-- which is honest — null here means "no table on record", and that is now
-- distinguishable from a takeaway only by the order's own type.

ALTER TABLE "orders" ADD COLUMN "tableNumber" TEXT;

UPDATE "orders" o
SET "tableNumber" = t."number"
FROM "restaurant_tables" t
WHERE o."tableId" = t."id" AND o."tableNumber" IS NULL;
