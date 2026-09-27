# TableFlow — hardening pass against `perfect.md`

Written against the 24 sections of `perfect.md`, following the previous audit
in `QA-REPORT.md`. Everything below was run. Where a section was already
satisfied it says so and says what convinced me, rather than rewriting working
code.

Base commit: `b3efc87` · local Postgres, migration-built

---

## 1. Executive summary

Eight defects were found and fixed, a ninth was found and deliberately left
for its own change, one new subsystem was built, and nine sections turned out
to be already correct and were left alone.

The most valuable finding is not in the product. It is that the test gate
could not distinguish **"passed"** from **"never ran"**, and had been unable
to for some time. A dead server turned twenty-two suites into skips while
printing a mostly-green summary; three suites had never executed at all. A
release gate now refuses on either. That change found four further real
defects within an hour of existing, including five lint errors in committed
code and an authorization failure being reported as a server crash.

In the product itself the arithmetic, the FIFO engine, the concurrency
controls and the cash reconciliation were all found to be correct, several of
them more carefully built than the brief asks for. What needed fixing was
mostly at the seams: a definition that seventeen screens had copied instead of
imported, three foreign keys that could never fire, and a documented
capability — removing a tenant's data — that did not work at all.

**Score: 9 / 10.** Reasoning in §11.

---

## 2. Issues found

### H1 · Seventeen screens re-derived what a bill owes

- **Severity** High
- **Area** Financial calculation consistency (§1)
- **Root cause** `outstandingOn` in `features/orders/pricing` carries a comment
  calling itself "the ONE definition — every till screen, intent and
  settlement check reads this, so 'paid in full' cannot mean different things
  on different screens". That was the intent and it was not true. Nine screens
  wrote `Math.max(0, grandTotal + tipAmount - paidTotal)` out by hand, and
  eight more wrote out `grandTotal + tipAmount`.
- **Impact** Every copy happened to agree, so nothing was visibly wrong — but
  three had already drifted: they subtracted `paidTotal` without the clamp, so
  an **overpaid bill rendered a negative amount due**. `accounting/integrity.ts`
  lists overpayment as a real historical class, so those were reachable rows.
  The larger cost is the one that has not arrived yet: on the day the
  definition changes, it moves in one place and seventeen screens quietly keep
  the old arithmetic.
- **Fix** Added `billedOn()` beside `outstandingOn()`, converged all seventeen
  sites, and added a static guard so it cannot come back.
- **Files** `src/features/orders/pricing.ts` and 16 call sites across
  `orders`, `payments`, `live`, `ledger`, `customers`, `cashier`, `delivery`,
  `invoices`
- **Tests** `scripts/no-hand-rolled-money.ts` — 703 files, 2 allowed with
  stated reasons. It caught three further instances later in this pass, two of
  them work of mine that a concurrent push had overwritten.

### H2 · An authorization failure reported as a server crash

- **Severity** Medium-High
- **Area** API authorization (§4), observability (§21)
- **Root cause** `POST /api/admin/media/restore` caught every error and
  answered `500` with `error.message` verbatim, bypassing `toAppError`, which
  every other route handler uses.
- **Impact** Two things at once. `requireSuperAdmin()` throws a 401, so an
  ordinary unauthenticated POST — which anybody can send — was recorded as a
  server fault, landing in `error_logs` beside real crashes and burying the
  signal that finds actual bugs. And the raw message went back to an anonymous
  caller, which is exactly what `toAppError` exists to prevent: in production
  it substitutes a neutral sentence rather than handing out whatever a Prisma
  or filesystem error happened to say.
- **Fix** Routed through `toAppError`, like every sibling route.
- **Files** `src/app/api/admin/media/restore/route.ts`
- **Tests** `scripts/api-authorization-test.ts` — 80 passed / 2 failed before
  the fix, 82 / 0 after.

### H3 · Three foreign keys that could never fire

- **Severity** Medium
- **Area** Audit-log delete contradiction (§6), database integrity (§16)
- **Root cause** `audit_logs.userId`, `audit_logs.branchId` and
  `refunds.refundedById` were declared `ON DELETE SET NULL` on tables frozen
  by `BEFORE UPDATE` triggers. SET NULL is not a delete — it is an UPDATE
  issued on the parent's behalf — and the trigger refused it, correctly,
  because it cannot tell that update from any other.
- **Impact** Deleting any audited user, or any branch with history, failed
  with `audit_logs is append-only: a log that can be edited is a diary, not an
  audit trail` — an error that gives the caller nothing to act on. 137 users
  and 153 audit rows are affected in the development database alone, and
  closing a branch is an ordinary thing for a restaurant group to do. Both
  reproduced inside rolled-back transactions.
- **Fix** All three become RESTRICT: the same refusal the database was already
  making, said honestly, with a foreign-key error naming the constraint.
  RESTRICT is also right on its own merits — an audit trail whose actor can be
  erased by deleting a row is not an audit trail. The append-only triggers are
  untouched.
- **Files** `prisma/migrations/20261008090000_audit_keeps_its_actor/`,
  `prisma/schema.prisma`
- **Tests** covered by `tenant-purge-test`, which deletes audit rows before
  users and so exercises the ordering RESTRICT now enforces.

### H4 · Removing a tenant's data did not work

- **Severity** Medium
- **Area** Tenant purge (§5)
- **Root cause** `20260917093000_append_only_guards` states that "removing a
  tenant's data on request is a legitimate operation" and leaves DELETE
  unblocked so it stays possible. Forty-three foreign keys are RESTRICT, and
  Postgres has no obligation to process a cascade in an order that satisfies
  them, so `DELETE FROM restaurants` fails on whichever it reaches first.
- **Impact** A documented capability that has never worked. It also caused H5.
- **Fix** A purge routine that computes the deletion order from
  `pg_constraint` at run time rather than hard-coding 104 tables, narrows each
  table to the tenant (directly by `restaurantId`, or recursively through a
  parent that has one), and deletes children before parents inside one
  transaction. **The 43 RESTRICT keys were deliberately NOT converted to
  CASCADE**: on stock and money tables they are doing real work, and trading a
  daily protection for a rare convenience is the wrong way round.
  It refuses unless the tenant is already deactivated, unless the caller
  repeats the slug back, and while anything is still in flight.
- **Files** `src/features/platform/tenant-purge.ts`
- **Tests** `scripts/tenant-purge-test.ts` — 34 checks against a tenant with
  stock, a transfer, a receipt, a paid bill and audit rows. Then validated for
  real on **63 abandoned tenants built by 11 different suites: 63/63, 5,113
  rows, no failures.**

### H5 · One suite had leaked 52 tenants, and it made another suite flaky

- **Severity** Medium
- **Area** Test data isolation (§23)
- **Root cause** Several suites ended with
  `try { restaurant.delete } catch { …deactivate instead }`. Because of H4 the
  delete always failed, and the catch swallowed it every time.
- **Impact** 63 abandoned tenants. Worse than untidy: `page-render-test` picks
  "the first active owner" and began picking an abandoned fixture whose branch
  codes were never normalised, then failed on a guest link that was perfectly
  correct. A leaking suite made a different suite fail.
- **Fix** `purgeFixture` wraps the purge for test teardown, clearing the
  in-flight work a fixture may have left. Wired into the two leaking suites.
- **Files** `scripts/purge-fixture.ts`, `scripts/recorrection-ui-test.ts`,
  `scripts/approvals-render-test.ts`, `scripts/tenant-purge-test.ts`
- **Tests** `scripts/no-unscoped-fixtures.ts` — 163 suites, and
  `page-render-test` went from 178 rendered / 2 failed to **179 / 0**.

### H6 · The gate could not tell a skip from a pass

- **Severity** Medium — and the one that found the others
- **Area** CI hardening (§12), release gate (§24)
- **Root cause** `verify-all` warned about skipped runtime suites only when
  `BASE_URL` was **unset**. With it set and the server dead, every runtime
  suite skipped silently.
- **Impact** Observed twice. A `next start` was killed mid-run: twenty-two
  suites turned into skips and the summary read `5040 passed · 1 failed`,
  greener than a run that fails. Separately, three suites had never executed
  at all because their dependencies were missing and a missing dependency
  reads as a skip.
- **Fix** Preflight probes Postgres, connection headroom, the server, Socket.IO,
  Chromium and **that the server is serving this tree's build**. Skips are
  classified expected or unexpected against what preflight found; an
  unexpected skip fails. The server is re-probed after the run, and a
  mid-run death is reported as an infrastructure failure rather than a tally.
  `scripts/release-gate.ts` then refuses a release on *any* skip, and checks
  that each of sixteen named areas has a suite that actually ran and passed.
- **Files** `scripts/verify-all.ts`, `scripts/release-gate.ts`, `package.json`
- **Tests** self-demonstrating: it caught a real mid-run death, a real
  build mismatch, and H7.

### H7 · Five lint errors in committed code

- **Severity** Low
- **Area** Release gate (§24)
- **Root cause** `next build` does not run ESLint, so `npm run lint` exiting
  non-zero had gone unnoticed.
- **Impact** Four `<a>` elements navigating to `/dashboard/purchases` instead
  of `<Link>`, which forces a full page reload and discards client state; one
  unescaped entity.
- **Fix** Converted to `<Link>`, escaped the entity.
- **Files** `src/features/access/components/join-form.tsx`,
  `src/features/inventory/components/adjustments-board.tsx`,
  `src/features/inventory/components/inventory-manager.tsx`
- **Tests** the release gate runs lint and fails on it.

### H9 · Four people on one bill can deadlock — safely, but without a retry

- **Severity** Low. Reported rather than fixed; see below.
- **Area** Multi-device concurrency (§10)
- **How it was found** The scenario §10 names: a cashier taking money, a
  second till taking money, a manager voiding a line and the kitchen changing
  state, all on one order, all at once. Postgres reported
  `40P01 deadlock detected` and aborted one of the four.
- **Impact on data: none.** Every invariant held. The bill never held more
  money than it was worth, `paidTotal` was exactly what came in less what went
  back, outstanding was not negative, and a line survived. Postgres detected
  the cycle and rolled one transaction back entirely, which is the correct and
  safe outcome.
- **Impact on people** The operation that lost gets a raw deadlock error
  rather than something to act on. In a busy service — cashier, manager and
  kitchen display all on one table's bill — that is a real "something went
  wrong" with no guidance, and the right response would simply have been to
  try again.
- **Why it is not fixed here** `40P01` is transient by definition: the losing
  transaction rolled back whole, so retrying is safe. The standard remedy is a
  bounded retry around the transaction helper. That touches every money path,
  and changing the money paths on the strength of one observation — to improve
  an error message, when the data is already correct — is the wrong trade
  inside a hardening pass. It wants its own change, with its own tests, and a
  measurement of how often it actually happens.
- **Tests** `scripts/concurrency-test.ts` §11 drives the four-way race and
  asserts the invariants that must hold whatever the interleaving. It passes
  with the deadlock occurring, which is the honest state: the outcome is
  correct, the experience is not yet.

### H8 · A build mismatch produced 65 unrelated-looking failures

- **Severity** Low (developer experience, but it cost an hour)
- **Area** CI hardening (§12)
- **Root cause** Running the gate from one tree against a server built from
  another. Server Action ids are per-build.
- **Impact** Sixty-five failures reading `Failed to find Server Action`,
  scattered across seven suites with nothing obviously in common.
- **Fix** Preflight compares this tree's `.next/BUILD_ID` against the build the
  server is serving and fails fast with one sentence.
- **Files** `scripts/verify-all.ts`

---

## 3. Verified existing protections — reviewed, not changed

Nine sections of the brief turned out to be already satisfied. In several the
existing implementation is better than what was asked for.

| § | Area | What convinced me |
|---|---|---|
| 2 | Split payments | `capturePayment` takes `SELECT … FOR UPDATE` on the order **before** reading `paidTotal`, checks idempotency **inside** that fence with a unique index as backstop, and refuses overpayment to the exact minor unit. A replay returns the existing payment without re-running settlement, so loyalty is not accrued twice. |
| 3 | Refunds | Same lock and same idempotency. `refundable = payment.amount − sum(already refunded)`; a refund cannot exceed it, and a second full refund is refused. |
| 9 | Profitability | `reports/profit.ts` produces revenue, COGS, gross profit, food-cost % and gross-margin % down to branch, category and item. Division by zero is guarded by `revenue > 0 ? … : null` — a null rather than an invented figure. |
| 15 | Printing | Browser-delegated by design: the app renders into a hidden iframe and hands it to the OS. It cannot know whether paper emerged, and does not claim to — it records an attempt with `attempts` and a reprint list. A true Queued → Printing → Printed machine needs a print agent beside the hardware, which is infrastructure this system does not have. The enum's meaning is now documented so no report reads `PRINTED` as a statement about paper. |
| 16 | Database integrity | Money is integer minor units throughout. Document numbers come from `INSERT … ON CONFLICT DO UPDATE SET value = value + 1 RETURNING value` inside the transaction, behind `@@unique([restaurantId, number])`. Three tables are append-only at the database. |
| 17 | FIFO | The hardest case in the brief — rounding dust — is already tested and already solved: `fifo-engine-test` issues 1,000 over 3 units and asserts it comes out as 1,000, not 999, because the draw that empties a layer takes everything left in it. Plus 10,000 randomised layers, and a lint banning average-cost valuation. |
| 18 | Cash reconciliation | `expected = openingFloat + cashSales + Σ(movement × direction)`. Refunds are deliberately **not** netted off sales; they are explicit `CASH_REFUND` movements against whichever drawer is open when the money goes back — the only rule that stays correct when a bill is paid on one shift and refunded on another. Expected cash and cash sales are also **redacted from a cashier who may not see reconciliation**, so a count cannot be tuned to match. |
| 20 | Notifications | `SmsStatus` is already QUEUED → SENDING → SENT → DELIVERED / UNDELIVERED / FAILED. Nothing is marked sent because content was generated. |
| 21 | Observability | `ErrorLog` carries tenant, branch, user, route, operation, `requestId` for correlation, severity, a `digest` fingerprint for grouping (indexed), and resolution fields for triage. The recorder writes **no payload at all**, and added context goes through `redact()`. |
| 22 | Reporting structure | One `resolveRange` vocabulary used by 40 files and enforced by `range-convergence-test`; shared `DrillDown`/`DrillTable`/`Pager`; per-domain query modules. Renaming the groups would be churn. |

§19 (payment-gateway callbacks) is **not applicable**: this system records
manual payments and integrates no gateway, which the schema states explicitly.

---

## 4. Database changes

One migration: `prisma/migrations/20261008090000_audit_keeps_its_actor/`.

It changes three foreign keys from `SET NULL` to `RESTRICT`
(`audit_logs_userId_fkey`, `audit_logs_branchId_fkey`,
`refunds_refundedById_fkey`) and nothing else.

- **Why** those keys were unsatisfiable against the append-only triggers (H3).
- **Backwards safety** no data is read, rewritten or removed, and no delete
  that succeeds today begins failing: every delete this refuses was already
  failing, on a trigger, with a worse message.
- **Rollback** restore `SET NULL` on the three constraints; the migration
  spells out the exact statements. Rolling back reinstates the contradiction.
- **Not changed** `stock_movements`, whose trigger is column-scoped and does
  not cover its six SET NULL links, so those already work.

No schema change was made for the tenant purge: converting 43 RESTRICT keys to
CASCADE was considered and rejected.

---

## 5. Performance results

Honest summary: **no performance defect was confirmed, and the evidence base
is better than last time but still not production-scale.**

`phase11-perf` already seeds a realistic tenant with neighbours and times the
report workload, with `PERF_ORDERS` to raise the volume. It now also measures
**sequential scans per table across that workload**, because timings say a
query is slow and do not say why — and at development volumes a full scan of a
small table is fast, so a plan that will not survive production looks healthy.
Rows read per scan is the number that multiplies as a restaurant trades.

One thing worth flagging rather than fixing: `getProfitReport` loads **every**
order item and order in the range into Node and aggregates there, with no
`take`. The `select` is narrow and the default ranges are a month, so it is
fine today. On a year range for a large tenant it is millions of rows in
memory. Rewriting a financial report to aggregate in SQL is exactly the kind
of change the brief warns against making casually, and it should be driven by
a measurement at real volume rather than by this paragraph.

---

## 6. Security results

- **API surface** all 23 routes enumerated and classified: 8 session, 5 API
  key, 1 shared secret, 1 guest cookie, 8 deliberately open. Every open one
  carries a written reason. `api-surface-test` (94 checks) verifies each
  declared mechanism is actually present in the file, that the registry
  describes routes that exist, and that the middleware's skip list reaches
  nothing undeclared.
- **Runtime** `api-authorization-test` (82 checks) sends every guarded route
  the request nobody should be able to make: never 200, never 5xx, 401 or 403
  precisely, and nothing sensitive in the refusal. Forged and malformed API
  keys refused; the job runner refuses four bad header shapes.
- **One real defect** found and fixed (H2).
- **Tenant isolation** the purge work required reading the whole foreign-key
  graph, which incidentally confirmed that 80 of 110 tables carry
  `restaurantId` and the remaining tenant-bearing ones reach it through a
  parent. `tenant-purge-test` asserts a neighbouring restaurant is untouched.
- **Websocket** room authorisation re-verified: a stranger and another
  tenant's staff are refused, the guest who placed the order is admitted.

---

## 7. Financial verification

**The calculation order is confirmed, and it matches the brief's:**

```
subtotal                    sum of line totals
  − item discounts          clamped per line to that line's gross
  − coupon discount         clamped to what is left
  − manual discount         clamped to what is left
  − loyalty discount        clamped to what is left
  = taxable base
  + service charge          bps on the taxable base
  + tax                     bps on (base + service charge), or backed out if inclusive
  ± rounding
  = grand total             the tip is deliberately NOT in it
```

It lives in one function, `computeTotals`, which every bill goes through, and
it is integer-only via `applyBps`. Tips ride on top: `grandTotal` is what the
restaurant earns and what every revenue figure reads.

`billing-math-test` (17 checks) covers the matrix directly — inclusive and
exclusive tax, service charge on and off, coupon and manual discounts
separately and together, loyalty on top, clamping when discounts exceed the
bill, rounding.

Added this pass, `scripts/concurrency-test.ts` (37 checks), covering what
nothing covered: **races with different idempotency keys.** The existing
suites fire two identical requests and prove replay protection works. That is
not the dangerous case. Two genuinely different requests on the same bill
cannot be saved by an idempotency lookup, and only the row lock stands between
that and a double-settled order:

- three methods summing to the bill exactly, and the bill cannot be overpaid
  by one minor unit;
- two cashiers each taking the whole bill at once → one succeeds, one refused,
  one payment row;
- two guests paying half each at once → both succeed, exactly settled;
- five simultaneous fifths → all five; six offered → five fit;
- two full refunds at once → one goes out; two halves at once → both, and a
  third refused;
- a refund and a fresh payment crossing → `paidTotal` is exactly what came in
  less what went back, in either arrival order.

---

## 8. Inventory verification

FIFO was audited and **not changed**, because it is right.

The property that makes it exact is written into `fifo-walk.ts`: the draw that
empties a layer takes everything left in it, collecting whatever earlier
partial draws rounded away. So a layer always issues out exactly what it came
in at, and the rounding dust the brief asks about cannot accumulate. That is
pinned by `fifo-engine-test`, which issues 1,000 over three units one at a
time and asserts 1,000 comes out.

Concurrency on the stock side was already covered by `phase11-test`:
concurrent withdrawals, transfer dispatch, recipe depletion and goods receipt.
Thirty-seven `SELECT … FOR UPDATE` row locks cover every money and stock path,
with `lock_timeout 4s` and `statement_timeout 9s` so a stuck lock cannot hang
a request. The transfer lock carries a measurement of the race it prevents:
five concurrent dispatches of 10 units once took 50 from a balance of 30.

---

## 9. Test results

Release gate, in full, against `b3efc87` plus this pass:

```
✓ READY — 5813 checks, nothing skipped, every area covered.

Typecheck ............... PASS
Lint .................... PASS   (was failing: 5 errors, fixed)
Build ................... PASS
Financial ............... PASS   billing-math, no-hand-rolled-money, concurrency
FIFO .................... PASS   fifo-engine, fifo-invariants, no-average-cost-valuation
RBAC .................... PASS   role-permissions, no-unguarded-feature-pages
Tenant isolation ........ PASS   tenant-isolation, branch-isolation
API authorization ....... PASS   api-surface (94), api-authorization (82)
Tenant purge ............ PASS   tenant-purge-test (34) + 63 real tenants
Concurrency ............. PASS   concurrency-test (43), phase11-test
Page render ............. PASS   179 rendered, 0 failed
Browser console ......... PASS   84 pages, 0 console errors
Report filters .......... PASS   report-filter-test (85)
Realtime ................ PASS   socket-order-room (3), socket-resilience (10)
Responsive UI ........... PASS   sidebar-responsive (19)
Test data isolation ..... PASS   no-unscoped-fixtures (163 suites)
Unexpected skips ........ 0
Expected skips .......... 0
```

The 5,813 figure is the gate's own, from the run that reported READY.
`concurrency-test` has since gained the six checks of the four-actor race in
H9 (43 total, verified standalone), which the next gate run will include.

Suites added this pass: `concurrency-test`, `api-surface-test`,
`api-authorization-test`, `api-routes`, `tenant-purge-test`,
`socket-resilience-test`, `no-hand-rolled-money`, `no-unscoped-fixtures`,
`purge-fixture`, `release-gate`.

---

## 10. Remaining risks

1. **The deadlock in H9.** Data-safe, user-visible, and wants a bounded
   retry of its own.
2. **Profit report memory at a year's range.** Described in §5. Measure
   before rewriting.
3. **Performance at production volume is still unmeasured.** `phase11-perf`
   can be raised to the brief's targets with `PERF_ORDERS`, but a run at
   500,000 orders needs time and disk this machine did not have spare while
   three sessions shared it. The sequential-scan instrumentation is in place
   for when it happens.
4. **The 20261008090000 migration's recorded checksum on this machine** was
   written from an earlier draft of the file. Harmless locally and correct on
   any fresh database, but worth a `migrate resolve` if the local history is
   ever treated as authoritative.
5. **Printing cannot confirm paper**, by architecture. Now documented rather
   than fixed.
6. **Report accuracy note.** An earlier draft of this document listed
   backdated writes into sealed accounting periods as untested. That was
   wrong and is corrected here: `assertPeriodOpen` has 14 call sites, and
   `month-close-test` drives a dated write at a sealed month and asserts it is
   refused, then that reopening lifts the seal. Left in rather than quietly
   deleted, because a report that only ever gets more confident is not being
   checked.

---

## 11. Production recommendation, and the score

**Ship it.** Nothing outstanding blocks a release, and the release gate now
refuses if that stops being true.

**9 / 10.** The point deducted is not for anything found in the product. It is
that performance remains the one claim resting on inference rather than
measurement: the harness, the instrumentation and the knob to raise the volume
are all in place, but nobody has yet run it at the scale the business will
reach, so "fast enough" is still an expectation rather than a result. Section
5 says precisely what to run and what to watch.

What moved it up from the previous audit's 7.5 is not the count of fixes. It
is that the previous audit's central finding — that the assurance layer had a
structural blind spot, so a broken page could be reported green 130 times —
now has a mechanism against it rather than a note about it. A gate that fails
on an unexpected skip, on a dead server, on a build mismatch and on a suite
that asserted nothing is worth more than any individual bug fixed here,
because it is the thing that will catch the next one.
