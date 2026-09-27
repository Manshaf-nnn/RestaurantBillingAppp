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
- **Heavy DDL sets a lock timeout.** A migration touching a hot table
  (`orders`, `stock_movements`, `inventory_items`) should begin with
  `SET lock_timeout = '5s'` so a blocked ALTER fails fast and rolls back
  instead of queueing the whole site behind it.
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

## Neon: how the provider is run

Production is one Neon project — since 2026-09-27 the paid project
"restaurantos" (endpoint `ep-purple-mud-az41kemf`, Singapore). Everything
below follows from the outage that day, when the previous project used up a
free-plan allowance and Neon refused every connection until somebody
noticed.

- **Two connection strings, both from the project's Connect dialog.**
  `DATABASE_URL` is the pooled one (host contains `-pooler`): the app serves
  from it. `DIRECT_URL` is the same without `-pooler`: migrations run over
  it, because a pooler cannot run `ALTER TYPE`. They rotate together.
- **They live in two places.** The server's `deploy/ovh/.env`, and the
  GitHub secrets `DATABASE_URL` / `DIRECT_URL`, which the deploy writes into
  that file. To rotate the role password: Neon → Reset password → update
  both secrets → push or "Run workflow". A refused string is rolled back.
- **Stay on a paid plan.** The app keeps the compute awake around the clock
  (health checks, the jobs loop), which is ~180 compute-hours a month —
  more than any free allowance. A free project will go dark mid-month.
- **Keep the card valid.** Neon invoices when the billing period closes and
  charges the card on file. An unpaid invoice is the other way a project
  gets suspended.
- **Set history retention to days, not hours.** Project settings → History
  retention. That is the point-in-time recovery window `/admin/backups`
  reports; six hours means a mistake found tomorrow cannot be undone.
- **Cap the compute.** Endpoint settings → autoscaling max. 8 CU is the
  default ceiling; this app rarely needs more than 1–2 and a runaway query
  should not be able to bill eight.
- **Watch it from `/admin/database`.** Connect a Neon API key there (Neon →
  Account settings → API keys, made in the organisation that owns the
  project). The platform then checks hourly — usage against quotas, the
  endpoint, whether the app is even connected to the watched project — and
  reminds the alert address before each invoice. Alerts also land under
  Errors. The key is sealed at rest with `CREDENTIAL_ENCRYPTION_KEY`.
- **When it does go wrong:** run the "Diagnose database" GitHub workflow
  first. It prints Neon's raw error from the server; Prisma's `P1001`
  paraphrase hides whether it was quota, password or hostname.

## Never losing the data

Two copies, in two places, on two mechanisms:

1. **Neon's point-in-time history** (same account): undoes a bad hour.
   Keep History retention at 7 days or more.
2. **The nightly "Backup database" workflow** (`.github/workflows/backup-db.yml`,
   03:00 Colombo): `pg_dump` over `DIRECT_URL`, restored into a throwaway
   Postgres and compared table-for-table and row-for-row with production,
   encrypted with the `BACKUP_PASSPHRASE` secret, kept as a GitHub artifact
   for 30 days. A night it cannot dump, cannot restore, or cannot encrypt
   is a red run — read those. The passphrase must live in a password
   manager: without it the artifacts are noise.

What is automatic: hourly watching and alerts, the invoice reminders, the
nightly verified backup, the deploy refusing a wrong database and rolling
its change back, the app reconnecting the moment the database answers.

What is not, and cannot be: paying Neon. Keep the card valid, keep the plan
paid, and read the reminder emails. A suspended project is intact but
unreadable, and the platform can only tell you — loudly and early — never
pay on your behalf.
