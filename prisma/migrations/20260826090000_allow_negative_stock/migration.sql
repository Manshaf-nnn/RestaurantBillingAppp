-- Whether an outward movement may take a balance below zero.
--
-- Previously hardcoded permissive in the ledger, with the `wentNegative` flag
-- computed and read by nobody. Defaults to false, which is what the spec asks
-- for; existing restaurants that rely on the old behaviour can turn it back on
-- in settings.
ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false;
