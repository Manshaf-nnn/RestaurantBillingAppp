-- The live floor board.
--
-- One settings column and two indexes. The board re-reads the floor every ten
-- seconds per open screen, so the indexes are not an optimisation — they are
-- what stops a busy Saturday turning into a sequential scan of the restaurant's
-- entire order history, twice a minute, per manager watching.

ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "liveBoardPolicy" JSONB;

-- "Their previous completed visit, and how many they have made."
--
-- Asked for every seated customer on every refresh. The existing index is
-- `(customerId)` alone, so answering it meant reading every order a regular has
-- ever placed, filtering the status on the heap and then sorting by date. With
-- twenty tables and a few hundred visits each that is thousands of rows sorted
-- every ten seconds; with this it is one range scan per customer.
CREATE INDEX IF NOT EXISTS "orders_customerId_status_placedAt_idx"
  ON "orders"("customerId", "status", "placedAt");

-- Everything currently on the floor.
--
-- A PARTIAL index, which Prisma cannot express — hence the hand-written
-- migration. The point is that it indexes only rows that are still open, so it
-- stays permanently tiny: a few dozen entries whether the restaurant has been
-- running for a week or ten years. The full `(restaurantId, branchId,
-- placedAt)` index would have to be walked past every historical order to reach
-- today's, and it grows for ever.
--
-- The predicate is written to match the board's WHERE clause exactly. Postgres
-- will only use a partial index when it can prove the query is a subset of the
-- predicate, so these two must stay in step — see `src/features/live/queries.ts`.
CREATE INDEX IF NOT EXISTS "orders_live_open_idx"
  ON "orders"("restaurantId", "branchId", "placedAt")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED');
