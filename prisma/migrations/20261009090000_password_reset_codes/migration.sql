-- Forgot password by emailed six-digit code (prisma/email.md).
--
-- Its own table rather than `verification_tokens`: a six-digit code needs an
-- attempt counter and a lockout, its hash is keyed (an unkeyed SHA-256 over a
-- million possibilities is a lookup table, not a hash), and it must be
-- unique per row rather than globally. `userId` is nullable on purpose — a
-- request for an address with no account still gets a row that behaves
-- identically and can never be redeemed, so nothing about the flow reveals
-- whether the address exists.

CREATE TABLE "password_reset_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "emailHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "flowNonceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "grantHash" TEXT,
    "grantExpiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "requestedIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_codes_grantHash_key" ON "password_reset_codes"("grantHash");
CREATE INDEX "password_reset_codes_emailHash_createdAt_idx" ON "password_reset_codes"("emailHash", "createdAt");
CREATE INDEX "password_reset_codes_userId_usedAt_idx" ON "password_reset_codes"("userId", "usedAt");
CREATE INDEX "password_reset_codes_expiresAt_idx" ON "password_reset_codes"("expiresAt");

ALTER TABLE "password_reset_codes" ADD CONSTRAINT "password_reset_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
