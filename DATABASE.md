# Database

Postgres via Prisma. Integer minor units for all money on hot paths;
`Decimal(18,6)` for `stockValue` (exact worth on hand) and quantities as
floats in base units with 1e-6 rounding at the edges.

## Rules

- **Migrations only.** `prisma/migrations/` applied with `migrate deploy`
  (locally and via `db:deploy:safe` on Netlify). Never `prisma db push`,
  never `--force`/`--accept-data-loss` against shared databases. Two pieces
  of deliberate drift exist and every hand-curated migration excludes them:
  the parked `recipe_items` table and the partial idempotency index on
  orders (partial indexes are invisible to Prisma's diff).
- **Additive or backfilled.** No migration rewrites ledger rows. Backfills
  state their provenance in SQL comments (discount split from redemption
  rows, refunds from flipped payments, loyalty opening balances, counters
  seeded at current counts).
- **CHECK constraints** guard the floors: non-negative money columns on
  orders, non-negative loyalty points, positive refund amounts.
- **Uniqueness is business truth**: order/invoice numbers per restaurant,
  depletion idempotency (`orderId,itemId`), SKU per restaurant, one daily
  close per business date, one counter row per (restaurant, key).
- **Locks**: `guardLocks` + `SELECT … FOR UPDATE` on the contended row
  (orders for settlement/refund/reconcile, items for stock, counts for
  approval) before any read-modify-write.

## Ledgers and caches

Ledger tables are append-only in spirit: `stock_movements`, `refunds`,
`loyalty_entries`, `order_stock_depletions` (reconciled quantities),
`audit_logs`, `print_jobs`. Cached aggregates (`Order.paidTotal`,
`InventoryItem.quantity`/`stockValue`, `Customer.loyaltyPoints`) are always
recomputable from their ledger, and `runIntegrityChecks` verifies each
identity on demand.
