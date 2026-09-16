-- abc.md §3 — a table is Empty, Occupied or Reserved. Nothing else.
--
-- The eight-value enum stays in Postgres: dropping a value is a destructive
-- migration and this history has none. The five extra values simply stop
-- being written — every writer now maps to AVAILABLE or OCCUPIED, RESERVED is
-- derived from bookings at read time, and out-of-service is `isActive`.
-- This moves the rows that still carry the old vocabulary.
--
-- ORDERING / EATING / WAITING_BILL all meant "somebody is sitting there".
-- CLEANING was where a paid table landed and stayed; the sitting is over, so
-- the table is Empty. A hand-set RESERVED is Empty too: the booking window
-- says Reserved now, and nothing ever un-set the old flag.

UPDATE "restaurant_tables" SET "status" = 'OCCUPIED'
 WHERE "status" IN ('ORDERING', 'EATING', 'WAITING_BILL');

UPDATE "restaurant_tables" SET "status" = 'AVAILABLE'
 WHERE "status" IN ('CLEANING', 'RESERVED');

UPDATE "restaurant_tables" SET "status" = 'AVAILABLE', "isActive" = false
 WHERE "status" = 'OUT_OF_SERVICE';
