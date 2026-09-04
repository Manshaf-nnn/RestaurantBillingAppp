# Production readiness — evidence

Written against `production.md`, whose closing rule is the one that shapes this
document: **do not call the system "production ready" just because tests pass.**

So this does not say that. It says what was checked, what was found, what was
fixed, what was measured, and what is still wrong. Where a number appears, the
command that produced it appears beside it.

**Date:** 2026-09-04 · **Verified against:** local PostgreSQL 16, all three test
tiers green.

---

## 1. What was checked

The starting point matters. This codebase had already been through a seven-slice
hardening pass (`AUDIT.md`), so the audit behind this work was looking for what
that pass deliberately did not reach — not re-litigating what it did.

Checked by reading the code, not the docs:

| Area | Method |
| --- | --- |
| Money representation | Every `Float` in `schema.prisma` classified as money / quantity / percentage |
| Idempotency | Every write path that moves money, traced from action to constraint |
| Transactions & locking | Every `postMovement` and `capturePayment` call site |
| Tenant isolation | Every service called with restaurant A's id and restaurant B's record |
| Period protection | Every call site of `assertPeriodOpen`, and every write path lacking one |
| Integrity coverage | All 22 existing checks mapped against §1's seven named areas |
| Error capture | Traced from a thrown error to a stored row — where it stopped |
| Realtime | Traced an order from `placeOrder` to a screen |
| Reports | Read `getSalesReport` / `getProfitReport` line by line against the timezone helpers |
| Migrations | All 55 read for destructive statements |
| Super Admin | Every route under `/admin` enumerated against §8's fifteen sections |

---

## 2. What was fixed

Each of these was a real defect, not a tidy-up. Ordered by what it would have
cost.

### Money could be taken twice

`capturePayment` and `refundPayment` had **no idempotency key**. The order-row
`FOR UPDATE` stopped two simultaneous taps; it did nothing about the request
that committed and then lost its response, which is what a flaky connection
actually produces.

The sharp edge was narrower and worse than it looks: retrying a *full* settle
happened to be refused by the overpayment ceiling (nothing outstanding the
second time), so the bug hid. Retrying a **partial** settle had room left on
the bill, passed every check, and booked the money twice.

- `Payment.clientRequestId` / `Refund.clientRequestId`, unique per restaurant.
- The till and refund dialog mint a key that **survives a failed attempt** — a
  key regenerated on retry looks like protection and provides none.
- Pinned: `payment-model-test` §9–§10, including concurrent same-key pairs.

### Sealed books did not protect money or stock

`assertPeriodOpen` existed and was called from five files — not from
`payments/service.ts`, and from **no** inventory path. Stock could move, and
therefore COGS and valuation could change, inside a period an accountant had
signed off.

- Guarded in `capturePayment`/`refundPayment`, and inside `postMovement` — the
  sole balance writer, so no future caller can forget it.
- `SALE`/`SALE_REVERSAL` are **deliberately exempt**: refusing a sale deduction
  rolls back the order that caused it, so sealing the current period would stop
  the kitchen serving. That trade is pinned in a test so nobody "fixes" it.

### Sales reports were bucketed in the wrong timezone

`getSalesReport` took no timezone at all. `byHour` used `placedAt.getHours()`
(the **server's** clock) and `byDay` used `toISOString().slice(0,10)` (**UTC**),
while the range around them was resolved correctly in the restaurant's zone.

On Netlify — a UTC host — an Asia/Colombo restaurant's "sales by hour" chart was
shifted 5½ hours and its days were cut at 05:30 local, putting an evening's
trade on the following morning. The existing test checked only that the hours
came back sorted, which they faithfully did.

Fixed by moving the aggregation into SQL with `localBucket()`, which corrects
the timezone and removes the unbounded read in the same change.

Two more raw-SQL date bindings were missing `utc()` — `reports/reconciliation.ts`
and `accounting/financial-reconciliation.ts` — the exact mistake `sql-time.ts`
documents. It surfaced as a value ladder reading zero, and only during part of
the day.

### Most errors were never recorded

`runAction` — which every mutation in the product passes through — caught the
error, returned a friendly message and `console.error`'d the rest. `ErrorLog`
only ever received exceptions escaping to Next's `onRequestError`, which Server
Actions do not reach. **The failures an operator most needed to see were the
ones never written down.**

- `runAction` now records to `ErrorLog`, with request id, operation, restaurant,
  branch, user and severity.
- Recorded, not awaited: an action must not fail differently because the error
  store is unavailable.

### Audit immutability was decoration

`assertAuditImmutable()` existed in `src/server/audit.ts` and **was never
called**. Its own comment explained that immutability held because "nothing in
the codebase calls `auditLog.update`" — a description of the source, dressed as
a guarantee. `phase7-test` "proved" it by calling the function and observing
that it threw, i.e. it tested that a function whose body is `throw` throws.

Replaced with enforcement that does not depend on anyone's care:

- `BEFORE UPDATE` triggers on `audit_logs` and `refunds` (frozen outright), on
  `stock_movements` (ledger facts frozen; the three legitimate link backfills
  still work) and on `payments` (a settled amount cannot change).
- `scripts/no-audit-mutation.ts` fails the build if application code acquires
  such a call site.

### A bought feature could only ever be looked at

`availablePermissions` was built from `permissionsForFeatures`, which adds each
feature's **primary** action only. `permissionsFor` intersects every role's
grants against it. So a restaurant that had bought Purchasing received
`purchase.view` and could never grant anybody — including the owner — the
ability to raise, approve or receive a purchase order. The feature was sold,
paid for, visible and inert.

Split into two functions that answer the two different questions, with the
role-layer behaviour deliberately unchanged.

### Three CHECK constraints AUDIT.md specified had never landed

`payments.amount >= 0`, `stock_movements.quantity <> 0`,
`inventory_items.costPerUnit >= 0`. Added `NOT VALID` then `VALIDATE`, per the
house pattern.

### `setup:prod` could reach the production database

It ran `prisma db push` — the command that leaves the "tables but no migration
history" state `deploy-db.mjs` exists to repair, and that can drop columns to
make a schema match. Now refuses any non-local host.

### The production seed printed a working password into the build log

`seed-production.ts` runs on **every** production deploy. With no
`SUPER_ADMIN_EMAIL` it defaulted to `admin@example.com`; with no password it
generated one and printed it. On a hosted build that is a live super-admin
credential sitting in the deploy log. It now refuses to run in CI without both.

### Realtime could lose an order

`realtime.*()` fired after commit and is a no-op on the serverless host, so a
placed order raised no durable event at all. Replaced with a transactional
outbox: the event is written **inside the same transaction** as the order,
payment or movement, so the two commit or roll back together.

### Orders were refused under load

Found by measurement, not by reading — see §4.

---

## 3. Tests

```
npx next build && npx next start -p 3210 &
BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/verify-all.ts
```

**2,266 passed · 0 failed · 1 skipped**, across all three tiers with the runtime
tier included. (The skip is `socket-order-room-test`, which self-skips unless the
server carries Socket.IO — it needs `node server.mjs`, not `next start`.)

Up from ~1,900 before this work. New suites:

| Suite | What it pins |
| --- | --- |
| `tenant-isolation-test` | Cross-restaurant boundary, 26 checks. Both tenants take exactly 100,000, so a report ignoring `restaurantId` reads 200,000 and looks entirely plausible |
| `db-constraint-test` | Every money/stock constraint refuses bad data, asserted **by constraint name** — a test that accepts any error passes when the constraint is dropped |
| `realtime-recovery-test` | A rolled-back transaction leaves **no** event behind; a reconnecting client catches up from its cursor |
| `jobs-test` | Two concurrent runners never take the same job; failures back off, stop, and are never swept away |
| `mfa-test` | RFC 6238 test vector; encrypted at rest; single-use recovery codes |
| `migration-safety-test` | No migration drops, truncates, or adds a blind unique index |
| `load-test` | §4's numbers — see below |
| `no-audit-mutation`, `no-unsafe-sw-cache` | Static guards |

Existing suites were **extended, not replaced** — `payment-model-test`,
`inventory-truth-test`, `hardening-test`, `feature-access-test`, `phase7-test`.

Two pre-existing test bugs were fixed, both of which passed for most of the day
and failed for part of it — the worst kind:

- `structural-test` sealed a period ending at "yesterday + 24h", which for a
  timezone ahead of UTC is still in the future for a few hours each evening.
- `tenant-isolation-test` (mine) first asserted on order *numbers*, which are
  per-restaurant sequences — so two tenants legitimately share `260903-001` and
  it reported a leak that was not there.

---

## 4. Performance — measured

Every figure below was produced by a command in this repository, against
**local PostgreSQL 16, not Neon**. Neon adds real network latency; these numbers
are a floor, not a forecast.

### Single-call latency, 20,000 orders / 60,000 lines

`npx tsx --tsconfig tsconfig.test.json scripts/phase11-perf.ts`

| Query | Before | After |
| --- | ---: | ---: |
| Sales report — this month | 63ms | **27ms** |
| Sales report — one branch | 24ms | **12ms** |
| Gross profit — last 30 days | 649ms | 639ms *(untouched)* |
| Dashboard stats | — | 4ms |
| Order list, page 200 (deep offset) | — | 13ms |

The sales figures are the SQL-aggregation rewrite. The profit figure is
unchanged because it was **not** rewritten — see §8.

### Under concurrent load

`LOAD_CONCURRENCY=24 LOAD_SECONDS=20 LOAD_HISTORY=6000 npx tsx ... scripts/load-test.ts`

24 workers against **one restaurant**, mixing order placement, kitchen reads,
settlement and reports.

| Operation | p50 | p95 | p99 | errors |
| --- | ---: | ---: | ---: | ---: |
| placeOrder | 254ms | 1621ms | 2527ms | 1 |
| capturePayment | 72ms | 121ms | 150ms | 0 |
| kitchenQueue | 57ms | 87ms | 105ms | 0 |
| cashierQueue | 24ms | 51ms | 66ms | 0 |
| salesReport | 86ms | 188ms | 225ms | 0 |
| dashboard | 42ms | 78ms | 87ms | 0 |

- **Throughput** 161 ops/s · **error rate 0.03%**
- **DB connections** peak 21 total, 12 active, 11 idle-in-transaction
- **DB cache hit ratio** 100% · 199,291 transactions
- **Node RSS** peak 835 MB

**What this run found.** The first execution refused **1.68% of orders** — 54 in
twenty seconds — all of them the unique constraint on
`(restaurantId, orderNumber)` after ten exhausted retries. The code comment
beside that ceiling claimed ten had "room to spare" at twenty concurrent
checkouts. It did not. Raising it to 24 with capped jitter took the error rate to
0.03%.

**The trade, stated plainly:** placeOrder's p99 went from 1545ms to 2527ms,
because the unlucky requests now retry rather than fail. A slow order is better
than a refused one, but it is slower, and that is a cost not a free win.

**"Database CPU"** — §4 asks for it. Postgres exposes no CPU percentage to a
client. Inventing one that an operator might act on during an incident is worse
than saying so, so what is reported is the work done and the cache hit ratio,
which is the figure that actually predicts whether more load will hurt.

---

## 5. Security

| Control | State |
| --- | --- |
| Tenant isolation | `restaurantId` from the verified session only, never from input. Swept by `tenant-isolation-test` |
| Branch scoping | Fail-closed — an empty allow-list renders `AND false`, never "no filter" |
| RBAC | Role ∪ per-user grants, intersected with what the platform sold. Static guard fails the build when a page's guard disagrees with its feature registration |
| **MFA** | **New.** TOTP (RFC 6238) with single-use recovery codes. Secret encrypted at rest with AES-256-GCM |
| Sessions | JWT access (15m) + rotating refresh (30d), httpOnly, separate admin namespace. Deactivating an account now revokes its sessions immediately |
| Rate limiting | Redis where configured, else Postgres counters shared across instances |
| Audit | Append-only, **enforced by database trigger** rather than by convention |
| Secrets | Redacted before anything is written; the seed no longer prints a password into build logs |
| Payment data | Never handled — no gateway, per §2 |
| CSP & headers | Already present in `next.config.mjs` (verified, not added) |

**MFA is reported as coverage, not enforced as a hard block.** Switching on
mandatory MFA for every existing owner in one deploy locks out every one who has
not enrolled — which, on the day of the deploy, is all of them. Coverage is on
`/admin/security`; enforcement is the follow-up once it reads 100%.

---

## 6. Database risks

**Low.** All 55 migrations are additive — no `DROP TABLE`, no `DROP COLUMN`, no
`TRUNCATE` anywhere in the history, now enforced by `migration-safety-test`.
This is the single property that makes "roll the code back, leave the migration"
a safe recovery strategy.

Remaining, honestly:

| Risk | Assessment |
| --- | --- |
| Quantities are `Float`, not `Decimal` | Bounded, not eliminated. All rounding now goes through one helper at 1e-6 (16 copies removed), and the ledger replay compares at the same precision. Money is unaffected — it is integer minor units throughout |
| Order numbers are MAX-derived | Contention is inherent to the scheme; the raised ceiling moves the limit, it does not remove it. The structural fix is the atomic counter invoices already use |
| Image bytes live in Postgres | Deliberate. It inflates database size and backup time; it is a known, accepted trade |
| `/api/health/db`'s expected-column list is hand-maintained | It will drift from the schema unless someone updates it |

---

## 7. Backup and recovery

**Neon performs the backups. This application performs none and does not
pretend to** — §10 is explicit about that, so there is no "back up now" button
and there never should be.

- `/admin/backups` reads the **real** Neon API for the PITR window, retention and
  branch history. With no `NEON_API_KEY` it says "not configured" and explains
  how — it does not show zeroes or a green tick.
- `RestoreTest` records who tested a restore, when, and whether it worked. The
  page shows **"never" in red** until somebody has, because a backup nobody has
  restored is a belief, not a backup.
- `DISASTER-RECOVERY.md` covers all six failures §16 names, with RPO/RTO stated
  up front and a printable incident checklist.
- `scripts/backup.ts` still exists and is now described honestly: a `pg_dump` to
  local disk, written for a VPS crontab, on a host that has no persistent
  filesystem. It is a convenience, not the strategy.

---

## 8. Remaining risks

The list this document exists for.

1. **`getProfitReport` is still JS aggregation over an unbounded read** —
   639ms at 20k orders, the slowest query measured. Not rewritten because its
   pro-rata discount apportionment is precisely what `report-agreement-test`
   exists to pin; it deserves its own change and its own measurement.
2. **Eight other unbounded `findMany` reads** in `reports/cash.ts`,
   `reconciliation.ts`, `what-if.ts`, `analytics/queries.ts`. Capping them with
   `take` would silently truncate an aggregate and produce a *wrong* number,
   which is worse than a slow one. They need the same SQL treatment as sales.
3. **Order placement contention** — measured, improved, not solved. See §6.
4. **MFA is not enforced**, only measured. See §5.
5. **All measurements are local.** Nothing here has been measured against Neon
   over a real network, and the connection-pool behaviour that matters most on
   serverless is exactly what a local run cannot show.
6. **The staging environment is configured but unproven** — `netlify.toml` has
   the context; nothing has been deployed through it yet.
7. **The scheduled job runner has never run on Netlify.** It is tested locally
   and by suite; the trigger itself is unexercised in production.
8. **No penetration test, no accessibility audit.** Both remain as `AUDIT.md`
   left them.
9. **The cache layer still has almost no callers.** `cached()` exists and is
   used for nothing; report caching was deferred behind measurement.
10. **Realtime is polling, by design.** Sockets remain off on serverless. The
    outbox makes it *reliable*, not *instant*.

---

## 9. What the OWNER must configure

Nothing in this list can be done from inside the application.

| # | What | Why it matters |
| --- | --- | --- |
| 1 | **Rotate the Neon database password** | It was exposed in 2026-08 and rotation is still pending. This is the highest-priority item on this page |
| 2 | `SUPER_ADMIN_EMAIL` + `SUPER_ADMIN_PASSWORD` in Netlify | The build now **refuses** without them, deliberately — see §2 |
| 3 | `JOBS_SECRET` | Without it the job endpoint refuses everything, and nothing scheduled runs |
| 4 | `NEON_API_KEY` + `NEON_PROJECT_ID` | Without them `/admin/backups` cannot see the real backup state |
| 5 | Check the Neon plan's **PITR retention** | If it retains no history, recovery is limited to manual dumps |
| 6 | Create the `staging` branch + a Neon **database branch** for it | §15's pipeline is configured but unproven |
| 7 | Enrol MFA on the super-admin account, and **keep the recovery codes** | They are shown once |
| 8 | Perform one restore test, and record it | `/admin/backups` says "never" until you do |
| 9 | `REDIS_URL` (optional) | Rate limits work without it, on Postgres counters, more slowly |

---

## 10. What the DEVELOPMENT TEAM must maintain

| What | Why |
| --- | --- |
| **Run the full three tiers before sign-off** | `SKIP_RUNTIME=1` is for iteration. The runtime tier is where the seam between button and service is checked, and it is where three stock-corrupting bugs once hid behind 636 green tests |
| **A regression test must fail before the fix** | A test that cannot fail is worse than no test — it reads as coverage. This pass removed one that had been passing vacuously for months |
| **Never add a check that cannot fail** | A `bank-match-shape` integrity check was written during this work and then **deleted**: a CHECK constraint already made the state unstorable, so it could only ever report OK |
| **Keep migrations additive** | Enforced now, but the enforcement only holds if nobody adds to the empty allow-list without a reason |
| **Pass `operation` to `runAction`** | Optional, and an error without it says only that "something in a POST failed" |
| **`emitOutbox` takes a `TxClient`, never `prisma`** | Outside the transaction it is the fire-and-forget emission this replaced. The branded type makes it a compile error |
| **Watch the load test's error rate, not just p99** | A refused order is worse than a slow one, and it is the number that found the real defect here |
| **Update `/api/health/db`'s expected-column list** | Hand-maintained; it drifts silently |
| **Re-measure after touching a report** | §4's numbers are dated. `phase11-perf` and `load-test` both run in `verify` now |

---

## The verdict

The money and stock core was already strong and is now stronger: payments and
refunds cannot be taken twice, sealed periods hold against money and stock,
history cannot be rewritten because the database refuses it, and the tenant
boundary is swept rather than assumed.

The read side had a real, live defect — reports bucketed in the wrong timezone —
that had been shipping for as long as reports existed, and the load test found
an order-refusal rate that a comment in the code had claimed was solved.

**This is not a statement that the system is production ready.** Ten things are
listed in §8 that are not, five of them measured. The most important sentence in
this document is in §9: the exposed database password has still not been
rotated, and no amount of the above compensates for that.
