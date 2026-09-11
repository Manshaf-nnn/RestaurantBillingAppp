-- bill.md §2 — where a payment is allocated for accounting.
--
-- TableFlow has no gateway and no bank API, so this records a bookkeeping
-- decision, not a transfer: which account the owner considers the money to
-- have landed in. The column stores the stable CODE of a destination defined
-- in `restaurants.paymentConfig`, never its display name — a code is minted
-- once and never edited, so a year of grouped reports stays stable while
-- correcting a typo in the name flows through to every label.

ALTER TABLE "payments" ADD COLUMN "destination" TEXT;
ALTER TABLE "refunds"  ADD COLUMN "destination" TEXT;

-- Reports group by it over a date range.
CREATE INDEX "payments_restaurantId_destination_paidAt_idx"
  ON "payments" ("restaurantId", "destination", "paidAt");

-- Give every restaurant a working set of destinations named after the methods
-- themselves, so settlement is never refused the moment this deploys. Owners
-- rename them to their real banks at leisure.
--
-- Historical payments keep destination NULL on purpose: backfilling would
-- invent a fact ("that 2024 cash sale went to BOC") nobody recorded. They
-- report as "Unassigned", which is honest and makes the rollout visible.
UPDATE "restaurants"
SET "paymentConfig" = COALESCE("paymentConfig", '{}'::jsonb) || jsonb_build_object(
  'destinations', jsonb_build_array(
    jsonb_build_object('code', 'cash',          'name', 'Cash',          'kind', 'CASH'),
    jsonb_build_object('code', 'card',          'name', 'Card',          'kind', 'BANK'),
    jsonb_build_object('code', 'qr',            'name', 'QR',            'kind', 'BANK'),
    jsonb_build_object('code', 'online',        'name', 'Online',        'kind', 'BANK'),
    jsonb_build_object('code', 'wallet',        'name', 'Wallet',        'kind', 'WALLET'),
    jsonb_build_object('code', 'bank_transfer', 'name', 'Bank transfer', 'kind', 'BANK'),
    jsonb_build_object('code', 'other',         'name', 'Other',         'kind', 'OTHER')),
  'methodDestinations', jsonb_build_object(
    'CASH', 'cash', 'CARD', 'card', 'QR', 'qr', 'ONLINE', 'online',
    'WALLET', 'wallet', 'BANK_TRANSFER', 'bank_transfer', 'OTHER', 'other'))
WHERE "paymentConfig" IS NULL
   OR NOT ("paymentConfig" ? 'methodDestinations');
