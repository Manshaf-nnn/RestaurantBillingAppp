-- websiteconnect.md — a restaurant's own website, connected to TableFlow.
--
-- One row per restaurant holds the credential its website presents. The key
-- is shown once and never stored; what lives here is its SHA-256, the same
-- rule refresh tokens follow, so a database leak yields nothing that can read
-- a menu or place an order. The row is the connection: deleting it kills the
-- key on the next request, and regenerating replaces the hash so the old key
-- dies the moment the new one is issued.
--
-- `connectedAt` stays NULL until the key has actually authenticated a request,
-- in the spirit of `restaurants.customDomainVerifiedAt`: a credential that was
-- issued is a claim, and one that has been used is a fact.

CREATE TABLE IF NOT EXISTS "website_connections" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "keyHash"      TEXT NOT NULL,
  "keyHint"      TEXT NOT NULL,
  "keyIssuedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "websiteUrl"   TEXT,
  "connectedAt"  TIMESTAMP(3),
  "lastSeenAt"   TIMESTAMP(3),
  "orderCount"   INTEGER NOT NULL DEFAULT 0,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "website_connections_pkey" PRIMARY KEY ("id")
);

-- One website per restaurant, and one restaurant per key.
CREATE UNIQUE INDEX IF NOT EXISTS "website_connections_restaurantId_key"
  ON "website_connections"("restaurantId");
CREATE UNIQUE INDEX IF NOT EXISTS "website_connections_keyHash_key"
  ON "website_connections"("keyHash");

ALTER TABLE "website_connections" DROP CONSTRAINT IF EXISTS "website_connections_restaurantId_fkey";
ALTER TABLE "website_connections" ADD CONSTRAINT "website_connections_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
