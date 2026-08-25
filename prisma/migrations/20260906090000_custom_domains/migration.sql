-- A restaurant on its own domain.
--
-- One deployment serves every tenant; which one a visitor sees has always come
-- from the URL path (/order/<slug>/<branch>) or, for staff, from their session.
-- Neither has ever depended on the hostname. These two columns let the hostname
-- answer the question as well, so a client can hand out their own address.
--
-- Both are nullable and default to NULL, which is the behaviour every existing
-- restaurant already has: use the shared address. Nothing changes for anybody
-- until an operator sets a domain and verifies it.


-- ── 1. The domain ────────────────────────────────────────────────────────────
--
-- Bare hostname: lower-cased, no scheme, no "www.", no port. The matcher
-- normalises the incoming Host the same way, so one stored shape covers
-- nilaza.lk, www.nilaza.lk and nilaza.lk:3000.
--
-- UNIQUE because a hostname can only mean one restaurant. Postgres treats NULLs
-- as distinct, so any number of restaurants can carry no domain at all.

ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "customDomain" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "restaurants_customDomain_key"
  ON "restaurants"("customDomain");


-- ── 2. Proof that it works ───────────────────────────────────────────────────
--
-- Set once the app has confirmed it answers on that hostname. An unverified
-- domain resolves nothing: without this, writing a row would be enough to aim a
-- hostname at another restaurant's menu, and the claim would never be tested
-- against reality.

ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "customDomainVerifiedAt" TIMESTAMP(3);
