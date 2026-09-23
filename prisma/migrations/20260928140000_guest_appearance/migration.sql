-- ar.md — one place that decides how guests are met, and codes that have no table.
--
-- `restaurants.guestExperience` is the welcome screen and menu layout for
-- EVERY code: the ordinary table QR and every QR menu read the same setting,
-- so a guest meets the same restaurant whichever card they scanned. Null means
-- the built-in defaults, which are exactly what the guest screens showed
-- before this column existed.
--
-- `qr_experiences.askTable` is off for a code with no table behind it — a
-- delivery leaflet, a takeaway counter, a window poster. Those guests cannot
-- answer "what is your table number?", and the order that comes out is a
-- TAKEAWAY rather than a DINE_IN with nowhere to sit.
--
-- Additive. No column is dropped, no row is rewritten, and no table carrying a
-- NOT VALID check is touched. Both new columns carry a default, so existing
-- rows keep behaving exactly as they do today.

ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "guestExperience" JSONB;

ALTER TABLE "qr_experiences"
  ADD COLUMN IF NOT EXISTS "askTable" BOOLEAN NOT NULL DEFAULT true;
