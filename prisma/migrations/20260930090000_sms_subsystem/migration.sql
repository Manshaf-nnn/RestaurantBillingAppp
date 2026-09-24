-- Bring-your-own SMS: a tenant's own gateway, what it sent, and codes texted
-- to phones that belong to no account.
--
-- `restaurants.smsConfig` holds the gateway an owner already pays for, with
-- the credentials sealed as AES-256-GCM ciphertext. Its own column rather than
-- a corner of `paymentConfig`, for the same reason `receiptConfig` was split
-- out of `printerConfig`: two forms writing one column is how one silently
-- erases the other's fields. Null means SMS is off, which is what every
-- existing tenant is — nothing starts texting because this migration ran.
--
-- `sms_messages` is a delivery log and not an audit row, because a delivery
-- status is mutable by definition and `audit_logs` is append-only, enforced by
-- a trigger. `SUPPRESSED` is a real status: a message we chose not to send is
-- recorded with its reason, because "nothing happened and nobody knows why" is
-- the failure this table exists to prevent.
--
-- `phone_otps` exists because `verification_tokens.userId` is a required FK to
-- a `User`, and a diner scanning a QR code has no user row. Its `tokenHash` is
-- also UNIQUE, which for a six-digit code means the second tenant to mint
-- `481920` in a minute would get a constraint violation instead of an OTP.
--
-- Additive throughout. Three new tables, four new enums, one new enum VALUE on
-- an existing type, and one nullable column. No column is dropped, no row is
-- rewritten, and no table carrying a NOT VALID check is touched. The one new
-- UNIQUE index is on a brand-new table, so it cannot fail on existing data.

-- ── The enum value on an existing type ───────────────────────────────────────
-- Additive and safe to run inside this transaction because nothing in this
-- migration USES the new value; Postgres only forbids reading a value in the
-- same transaction that added it.
ALTER TYPE "TokenPurpose" ADD VALUE IF NOT EXISTS 'PHONE_VERIFICATION';

-- ── New enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "SmsPurpose" AS ENUM ('TEST', 'OTP', 'RECEIPT', 'ORDER_STATUS', 'RESERVATION', 'STAFF', 'MARKETING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'UNDELIVERED', 'FAILED', 'SUPPRESSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SmsEncoding" AS ENUM ('GSM7', 'UCS2');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "OtpPurpose" AS ENUM ('LOYALTY_LOOKUP', 'GUEST_ORDER', 'RESERVATION', 'STAFF_LOGIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── The tenant's gateway ─────────────────────────────────────────────────────
ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "smsConfig" JSONB;

-- ── The delivery log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sms_messages" (
  "id"                TEXT NOT NULL,
  "restaurantId"      TEXT NOT NULL,
  "branchId"          TEXT,
  "purpose"           "SmsPurpose" NOT NULL,
  "status"            "SmsStatus" NOT NULL DEFAULT 'QUEUED',
  "provider"          TEXT NOT NULL,
  "toE164"            TEXT NOT NULL,
  "toRaw"             TEXT NOT NULL,
  "senderId"          TEXT,
  -- NULL for purpose = 'OTP'. A support engineer must not be able to read a
  -- live verification code, and a backup of this table must not be a list of
  -- them. Enforced in sendSms() rather than by a constraint, because a partial
  -- CHECK here would fail the migration-safety rules for no added protection.
  "body"              TEXT,
  "segments"          INTEGER NOT NULL DEFAULT 1,
  "encoding"          "SmsEncoding" NOT NULL DEFAULT 'GSM7',
  "costMinor"         INTEGER,
  "providerMessageId" TEXT,
  "providerStatus"    TEXT,
  "errorCode"         TEXT,
  "errorMessage"      TEXT,
  "rawResponse"       TEXT,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "dedupeKey"         TEXT,
  "entity"            TEXT,
  "entityId"          TEXT,
  "requestedById"     TEXT,
  "sentAt"            TIMESTAMP(3),
  "deliveredAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sms_messages_dedupeKey_key"
  ON "sms_messages" ("dedupeKey");
CREATE INDEX IF NOT EXISTS "sms_messages_restaurantId_createdAt_idx"
  ON "sms_messages" ("restaurantId", "createdAt");
CREATE INDEX IF NOT EXISTS "sms_messages_restaurantId_status_createdAt_idx"
  ON "sms_messages" ("restaurantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "sms_messages_restaurantId_purpose_createdAt_idx"
  ON "sms_messages" ("restaurantId", "purpose", "createdAt");
-- A delivery report arrives knowing only the gateway's own id.
CREATE INDEX IF NOT EXISTS "sms_messages_providerMessageId_idx"
  ON "sms_messages" ("providerMessageId");
-- The per-recipient daily cap counts over this.
CREATE INDEX IF NOT EXISTS "sms_messages_restaurantId_toE164_createdAt_idx"
  ON "sms_messages" ("restaurantId", "toE164", "createdAt");

DO $$ BEGIN
  ALTER TABLE "sms_messages"
    ADD CONSTRAINT "sms_messages_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Codes for phones with no account ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "phone_otps" (
  "id"             TEXT NOT NULL,
  "restaurantId"   TEXT NOT NULL,
  "purpose"        "OtpPurpose" NOT NULL,
  -- The identity form from phoneKey(), so a guest who typed 077… once and
  -- +94 77… the next time is one person to the throttle and to the lockout.
  "phoneKey"       TEXT NOT NULL,
  "toE164"         TEXT NOT NULL,
  -- An HMAC, not a bare SHA-256: six digits is 10^6 possibilities, which a
  -- plain hash surrenders instantly to a rainbow table built from a dump.
  "codeHash"       TEXT NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"    INTEGER NOT NULL DEFAULT 5,
  "usedAt"         TIMESTAMP(3),
  -- A locked row is never deleted: the lockout has to outlive the code it
  -- protected, or a resend walks straight past it.
  "lockedAt"       TIMESTAMP(3),
  "smsMessageId"   TEXT,
  "guestSessionId" TEXT,
  "ipHash"         TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "phone_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "phone_otps_restaurantId_phoneKey_purpose_createdAt_idx"
  ON "phone_otps" ("restaurantId", "phoneKey", "purpose", "createdAt");
CREATE INDEX IF NOT EXISTS "phone_otps_expiresAt_idx"
  ON "phone_otps" ("expiresAt");

DO $$ BEGIN
  ALTER TABLE "phone_otps"
    ADD CONSTRAINT "phone_otps_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
