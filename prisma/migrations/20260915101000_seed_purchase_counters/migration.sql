-- Purchase numbers move onto the named counter (same fix invoices got).
-- Seed each restaurant at its current count so the sequence continues.
INSERT INTO "restaurant_counters" ("restaurantId", "key", "value")
SELECT "restaurantId", 'purchase', COUNT(*)
FROM "purchases"
GROUP BY "restaurantId"
ON CONFLICT ("restaurantId", "key") DO NOTHING;
