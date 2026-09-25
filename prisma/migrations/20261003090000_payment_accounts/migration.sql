-- Internal money accounts: balances, deposits and transfers (bank.md).
--
-- ── What this is, and what already existed ──────────────────────────────────
--
-- An "account" is not new. `Restaurant.paymentConfig.destinations` has held one
-- since payment destinations were added: a code, a name, and the bank details
-- an owner wanted recorded. Every `payments.destination` and
-- `refunds.destination` already stamps that code.
--
-- What never existed is a BALANCE, a way to put money in, and a way to move it
-- between accounts. None of those can live in a JSON blob: a balance has to be
-- read under a row lock, a ledger row has to reference the account by key, and
-- one settings form rewriting the whole column would clobber the lot.
--
-- So the accounts are promoted to a table, keeping their codes, and the two
-- facts with nowhere else to live — deposits and transfers — get a ledger.
--
-- ── Why there is no PAYMENT row in that ledger ──────────────────────────────
--
-- Because a payment is already attributed to an account by
-- `payments.destination`. Writing a second row for it would give the same
-- rupees two records that disagree the first time a payment is refunded — the
-- reasoning `CashMovementType` already carries for why it has no CASH_SALE
-- member. An account's balance therefore reads BOTH sources:
--
--   SUM(entries)  +  SUM(payments.destination = code)  -  SUM(refunds.destination = code)
--
-- which cannot drift from the history, because it IS the history.
--
-- Entirely additive. Nothing is dropped, and `paymentConfig.destinations` is
-- left in place rather than deleted — a migration that removes the old copy
-- before the new one has been read in anger has nowhere to fall back to.

-- ── 1. The accounts ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "payment_accounts" (
  "id"            TEXT NOT NULL,
  "restaurantId"  TEXT NOT NULL,
  "code"          TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "bankName"      TEXT,
  "accountNumber" TEXT,
  "holderName"    TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_accounts_pkey" PRIMARY KEY ("id")
);

-- The code is the identity every stamped payment already carries, so it has to
-- name one account.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_accounts_restaurantId_code_key"
  ON "payment_accounts" ("restaurantId", "code");
CREATE INDEX IF NOT EXISTS "payment_accounts_restaurantId_isActive_idx"
  ON "payment_accounts" ("restaurantId", "isActive");

DO $$
BEGIN
  ALTER TABLE "payment_accounts"
    ADD CONSTRAINT "payment_accounts_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. The ledger — deposits and transfers only ─────────────────────────────

DO $$
BEGIN
  CREATE TYPE "PaymentAccountEntryType" AS ENUM ('DEPOSIT', 'TRANSFER_IN', 'TRANSFER_OUT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "payment_account_entries" (
  "id"                    TEXT NOT NULL,
  "restaurantId"          TEXT NOT NULL,
  "accountId"             TEXT NOT NULL,
  "type"                  "PaymentAccountEntryType" NOT NULL,
  -- Always positive; the type carries the direction.
  "amount"                INTEGER NOT NULL,
  "reason"                TEXT,
  "counterpartyAccountId" TEXT,
  "transferGroupId"       TEXT,
  "userId"                TEXT,
  "actorName"             TEXT,
  "clientRequestId"       TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_account_entries_pkey" PRIMARY KEY ("id")
);

-- One key per attempt, so a double tap deposits once. The same shape
-- `payments` uses, and the backstop behind the in-transaction replay read.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_account_entries_restaurantId_clientRequestId_key"
  ON "payment_account_entries" ("restaurantId", "clientRequestId");
CREATE INDEX IF NOT EXISTS "payment_account_entries_accountId_createdAt_idx"
  ON "payment_account_entries" ("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "payment_account_entries_restaurantId_transferGroupId_idx"
  ON "payment_account_entries" ("restaurantId", "transferGroupId");

-- Money moved is never negative, and a transfer always names its other half.
DO $$
BEGIN
  ALTER TABLE "payment_account_entries"
    ADD CONSTRAINT "payment_account_entries_amount_positive"
    CHECK ("amount" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "payment_account_entries" VALIDATE CONSTRAINT "payment_account_entries_amount_positive";

DO $$
BEGIN
  ALTER TABLE "payment_account_entries"
    ADD CONSTRAINT "payment_account_entries_transfer_paired"
    CHECK (
      ("type" = 'DEPOSIT' AND "transferGroupId" IS NULL)
      OR ("type" IN ('TRANSFER_IN', 'TRANSFER_OUT') AND "transferGroupId" IS NOT NULL)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "payment_account_entries" VALIDATE CONSTRAINT "payment_account_entries_transfer_paired";

DO $$
BEGIN
  ALTER TABLE "payment_account_entries"
    ADD CONSTRAINT "payment_account_entries_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "payment_account_entries"
    ADD CONSTRAINT "payment_account_entries_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "payment_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "payment_account_entries"
    ADD CONSTRAINT "payment_account_entries_counterpartyAccountId_fkey"
    FOREIGN KEY ("counterpartyAccountId") REFERENCES "payment_accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "payment_account_entries"
    ADD CONSTRAINT "payment_account_entries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Who may use an account ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "payment_account_staff" (
  "id"          TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "canTransfer" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_account_staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_account_staff_accountId_userId_key"
  ON "payment_account_staff" ("accountId", "userId");
CREATE INDEX IF NOT EXISTS "payment_account_staff_userId_idx"
  ON "payment_account_staff" ("userId");

DO $$
BEGIN
  ALTER TABLE "payment_account_staff"
    ADD CONSTRAINT "payment_account_staff_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "payment_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "payment_account_staff"
    ADD CONSTRAINT "payment_account_staff_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. The balance query needs these ────────────────────────────────────────
--
-- Both columns have been read by `getDestinationTotals` with a GROUP BY since
-- destinations were added, and neither was indexed. The balance groups by them
-- on every card.

CREATE INDEX IF NOT EXISTS "payments_restaurantId_destination_idx"
  ON "payments" ("restaurantId", "destination");
CREATE INDEX IF NOT EXISTS "refunds_restaurantId_destination_idx"
  ON "refunds" ("restaurantId", "destination");

-- ── 5. The existing accounts, copied across ─────────────────────────────────
--
-- Every destination an owner has configured becomes a row, keeping its code so
-- that every payment already stamped with it still resolves. `archived` becomes
-- `isActive = false` — retired, still holding its history.

INSERT INTO "payment_accounts" (
  "id", "restaurantId", "code", "name", "bankName", "accountNumber", "holderName",
  "isActive", "createdAt", "updatedAt"
)
SELECT
  'pacc_' || md5(r."id" || ':' || (d.value ->> 'code')),
  r."id",
  d.value ->> 'code',
  COALESCE(NULLIF(d.value ->> 'name', ''), d.value ->> 'code'),
  NULLIF(d.value ->> 'bankName', ''),
  NULLIF(d.value ->> 'accountNumber', ''),
  NULLIF(d.value ->> 'holderName', ''),
  COALESCE((d.value ->> 'archived')::BOOLEAN, false) IS NOT TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "restaurants" r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(r."paymentConfig"::jsonb -> 'destinations') = 'array'
      THEN r."paymentConfig"::jsonb -> 'destinations'
    ELSE '[]'::jsonb
  END
) AS d(value)
WHERE COALESCE(d.value ->> 'code', '') <> ''
ON CONFLICT ("restaurantId", "code") DO NOTHING;

-- ── 6. Restaurants that never opened the setting ────────────────────────────
--
-- `readPaymentConfig` hands those a default book of accounts, so their tills
-- work today and `destinationForMethod` resolves CASH to a destination called
-- `cash`. Once the account row is what gets resolved, a restaurant with no rows
-- could not take a payment at all — a till outage on deploy day for every one
-- of them.
--
-- So the same defaults are written as real rows, for any restaurant that has
-- none. An owner renames them to their real banks the first time they look,
-- which is exactly what the JSON defaults were for.

INSERT INTO "payment_accounts" (
  "id", "restaurantId", "code", "name", "isActive", "createdAt", "updatedAt"
)
SELECT
  'pacc_' || md5(r."id" || ':' || seed.code),
  r."id",
  seed.code,
  seed.name,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "restaurants" r
CROSS JOIN (VALUES
  ('cash',          'Cash'),
  ('card',          'Card'),
  ('qr',            'QR'),
  ('online',        'Online'),
  ('wallet',        'Wallet'),
  ('bank_transfer', 'Bank transfer'),
  ('other',         'Other')
) AS seed(code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM "payment_accounts" a WHERE a."restaurantId" = r."id"
)
ON CONFLICT ("restaurantId", "code") DO NOTHING;

-- ── 7. An entry is a fact ───────────────────────────────────────────────────
--
-- bank.md §3: "Never edit historical transactions directly." The database
-- refuses it, not just the application — the same guard `stock_movements` and
-- `refunds` already carry. DELETE stays permitted so removing a tenant can
-- still cascade.

CREATE OR REPLACE FUNCTION tableflow_payment_account_entries_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW."amount"       IS DISTINCT FROM OLD."amount"
  OR NEW."type"         IS DISTINCT FROM OLD."type"
  OR NEW."accountId"    IS DISTINCT FROM OLD."accountId"
  OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
  OR NEW."createdAt"    IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'an account movement is a fact: record the opposite movement rather than editing it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_account_entries_immutable ON "payment_account_entries";
CREATE TRIGGER payment_account_entries_immutable
  BEFORE UPDATE ON "payment_account_entries"
  FOR EACH ROW EXECUTE FUNCTION tableflow_payment_account_entries_immutable();
