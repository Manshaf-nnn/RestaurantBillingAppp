-- correctionA.md §4 — the cashier counts notes and coins, not a total.
--
-- The physical total is derived from these counts on the server. Storing the
-- breakdown rather than only the sum is what makes the closure preview
-- printable and a disputed count re-checkable: "the drawer was Rs 2,000 short"
-- is an accusation, "there were four 500s where the count says six" is a
-- conversation.
--
-- Keyed by face value in minor units, so the row stays readable against
-- `denominationsFor(currency)` no matter what an owner later changes.
--
-- Nullable and additive. Null is the correct reading of every drawer closed
-- before this existed, and of one force-closed by a manager with nobody there
-- to count it.

ALTER TABLE "cash_drawer_sessions" ADD COLUMN "closingCounts" JSONB;
