# TableFlow — QA audit

Written against `QA.md`. Every claim below is backed by something that was run,
and where a claim could not be established the report says so rather than
filling the gap.

Audit date: 2026-09-27 · HEAD at audit: `3bbb9ee` · local Postgres, migration-built

---

## 1. Overall rating: 7.5 / 10

This is a mature, unusually well-engineered codebase. Money is integer minor
units end to end, document numbers are allocated by an atomic counter behind a
unique index, thirty-seven row locks guard the money and stock paths, three
tables are append-only at the database level, and there is a genuine culture of
static guards that encode past bugs as lints with written reasons.

It does not score higher because of what the audit found about the *checks*
rather than the code. A main report was broken for every multi-location tenant,
threw on every request, recorded 89 errors in the database over several days,
and was reported green 130 times by the suite that exists to catch exactly
that. Twenty-six pages had never been loaded by any check at all. Three suites
had never once executed. The engineering is strong; the assurance that it stays
strong had holes in it, and those holes are what a rating is supposed to
measure.

## 2. Ratings

| Area | Score | Basis |
|---|---|---|
| Functionality | 8 | 5403 checks green; all seven critical workflows have dedicated suites; 84 pages render clean in a real browser |
| Financial correctness | 8 | Integer minor units throughout; atomic counters; row locks; dedicated billing, sales-detail, ledger and close suites. Deep arithmetic audit not completed — see §7 |
| Inventory / FIFO | 8 | Engine test over 10,000 randomised layers, plus invariants, transfer, returns and production suites, and a lint banning average-cost valuation |
| Security | 7 | Websocket tenant isolation proven; scoped-mutation pattern sound where read; append-only triggers. The systematic API-route authorisation table was not completed — see §7 |
| Data integrity | 8 | Append-only triggers, unique constraints, atomic counters, 37 row locks. Two defects found, both in deletion paths |
| RBAC | 8 | Four static lints plus six dedicated suites; spot-checks clean |
| Realtime | 7 | Room authorisation proven correct for three cases; reconnect and duplicate-event behaviour untested |
| Performance | 5 | **Weakest evidence in this audit.** Largest table holds 6,352 rows, so nothing exercises scale |
| UI / UX | 8 | Zero console errors across 84 pages; responsive verified at three widths; PWA installable and genuinely offline |
| Testing | 7 | 5403 checks and ~180 suites, but three had never run, 26 routes were unswept, and the HTTP render layer was blind to a whole error class |
| Production readiness | 7 | Ship-worthy, with the reservations in §8 |

## 3. Bugs

### Critical
None found.

### High

**H1 — The Purchasing report was broken for every multi-location tenant**

- **Feature** · Purchasing report, `/dashboard/reports/purchasing`
- **Reproduction** · Sign in as an owner of a tenant with more than one location and choose a location. The page returns HTTP 200 and then shows "This page could not load".
- **Root cause** · `src/app/dashboard/reports/purchasing/page.tsx` narrowed price history with `where: { purchase: { branchId } }`. `PurchasePriceHistory` has no `purchase` relation — it carries `itemId`, `supplierId` and a bare `receiptId` column with no relation behind it. Prisma rejects an unknown argument before it reads a row, so this threw on an empty table, on every tenant, every time. The comment above the line asserted the relation existed; the line was carried forward verbatim into a rewrite without checking.
- **Evidence it was live** · 89 rows in `error_logs`, most recent the morning of the audit, all on `/dashboard/reports/purchasing?branch=…`. A single request reproduced it as `+1` row.
- **Fix** · Moved to `listPriceMoves` in `src/features/purchasing/queries.ts`, which resolves the branch through the goods receipts that recorded each price — the same two-step `getItemPriceInsight` already uses, scoped by the period first so the `in` list is bounded by the window on screen.
- **Test result** · `report-filter-test` 12 failed before the fix, 0 after. `error_logs` delta `+1` per request before, `0` across an 85-request matrix after. `price-moves-test` proves it *filters* rather than merely stopping throwing: two branches, two prices, the +40% trend the report prints, and an empty result for another tenant's branch id. 14 passed.

**H2 — Every HTTP render check was blind to streamed server-component errors**

- **Feature** · Test infrastructure, and therefore every `force-dynamic` page
- **Reproduction** · Point `page-render-test` at a page that throws after its shell flushes. It reports a pass.
- **Root cause** · An App Router `force-dynamic` page streams. Next flushes the shell before the loaders resolve, so the status line is already 200 when a loader throws; the error arrives as a later chunk and the error boundary is rendered by the browser, so its text never appears in the HTML either. Checking the status and the boundary's words therefore cannot see the failure. This is why H1 survived 130 green page-loads across two passes and was eventually found in a database table instead.
- **Fix** · `scripts/streamed-error.ts`, which reads the RSC error record `<id>:E{"digest":"…"}` and React's `$RX=` reject helper. It ignores `NEXT_REDIRECT`, `NEXT_NOT_FOUND` and `DYNAMIC_SERVER_USAGE`, which are control flow implemented by throwing and were initially reported as failures on two pages that redirect legitimately; and it scans every error record rather than the first, so a redirect in one segment cannot mask a throw in another. Wired into `page-render-test` and `report-filter-test`.
- **Test result** · The same sweep now reports 129 rendered / 1 failed against the pre-fix build and 130 / 0 against the fixed one — so the detector is demonstrably not a no-op.

### Medium

**M1 — Twenty-six dashboard routes were in no sweep**

The entire accounting module (11 routes), the daily close, the inventory ledger
and adjustments, the four inventory report drill-downs, categories, kitchen
stations, online payments, menu import, new purchase and two settings pages had
never been loaded by any check. Added to a new shared `scripts/dashboard-pages.ts`
that both sweeps import, so a page added for one is covered by the other. All
render clean, in a browser, with a silent console.

**M2 — Three suites had never executed**

`recorrection-ui-test` and `sidebar-responsive-test` need Playwright's browser
binary, a separate ~95MB download `npm install` does not perform.
`socket-order-room-test` needs Socket.IO, which plain `next start` does not
serve. All three self-skip rather than fail, so the gate reported green while
responsive behaviour, websocket room authorisation and 86 UI assertions had
never run once. Installed chromium and ran `server.mjs`; all three now pass, and
`browser-console-test` was added alongside them. **A skip is untested, not
passed** — worth treating that way in future runs.

On first execution `recorrection-ui-test` failed five assertions. All five were
defective expectations rather than product defects, and each was corrected so it
asserts the same fact against the real markup:

| Assertion | Why it could never pass |
|---|---|
| `Stock transfers (1)` on two desks | The approvals desk was intentionally rebuilt around request type; the label is now "Stock transfer" with the count in a separate badge |
| `/Requested/`, `/Approved/` on the transfers board | `getByText(…).first()` resolved to `<option>Requested</option>` inside a closed `<select>` above the table, which Playwright correctly calls invisible, and never reached the badge below |
| The in-progress production row | `innerText` returns empty for a hidden element, and the assertion ran before the tab panel became visible |

**M3 — Tenant deletion does not work** *(reported, not fixed)*

The `append_only_guards` migration states that "removing a tenant's data on
request is a legitimate operation" and that DELETE is deliberately left
unblocked for it. It nonetheless fails. Reproduced inside a transaction that was
rolled back:

```
BEGIN; DELETE FROM restaurants WHERE id = '…';
ERROR: update or delete on table "inventory_items" violates foreign key
constraint "stock_transfer_lines_itemId_fkey" on table "stock_transfer_lines"
```

Forty-three foreign keys are `RESTRICT`, mostly onto `branches` and
`inventory_items`, and the cascade from `restaurants` cannot satisfy them in any
order. **Not fixed deliberately**: changing 43 constraints on money and stock
tables is a migration with real risk, and the safer remedy is a purge routine
that deletes in dependency order. That is a scope decision for you, not one to
take inside a QA pass.

**M4 — `live-board-test` read another suite's fixture**

`prisma.customer.findFirstOrThrow({ where: { phone: '0772222222' } })` with no
`restaurantId` matched a leftover customer belonging to a different tenant's
test fixture, so two assertions failed on a customer that was entirely correct.
Scoped to its own restaurant. 79 passed, 0 failed. The same unscoped-lookup
mistake the product itself is linted against.

### Low

**L1 — Deleting a user who has ever been audited fails**

`AuditLog.user` is `onDelete: SetNull`; SetNull is an UPDATE; the
`audit_logs_append_only` trigger refuses every UPDATE. So a hard delete of any
audited user raises `check_violation`. Reproduced and rolled back; 137 users
currently hold audit rows. **No product path reaches this** — staff removal soft
-deletes, setting `isActive: false` and `deletedAt` — so the impact today is
confined to test cleanup, where it aborted `socket-order-room-test` and left
fixtures behind. Fixed there by clearing the audit rows first. The schema/trigger
contradiction itself is left as a note.

**L2 — Two pages redirect after flushing a shell**

`/dashboard/online-payments` and `/dashboard/settings/guest` both moved, and
redirect from inside the page rather than at the edge, so a shell is streamed
and discarded. Harmless, and Next handles it; noted only because it is what
surfaced the need for the control-flow exclusion in H2's detector.

**L3 — A regression this audit introduced, found and fixed**

Extracting the page list into its own module broke `invoices-list-test`, which
asserted `/dashboard/invoices` was swept by reading `scripts/page-render-test.ts`
as text and grepping for the literal string. It now imports the array, which
says what it means and survives the next move. 28 passed.

**L4 — The gate's total under-counts the sweep suites**

`verify-all` tallies a suite by matching `N passed, M failed` in its output and
counts the whole suite as **one** check when it finds no such line.
`page-render-test` prints "130 rendered, 0 failed", which does not match, so 130
page-loads contribute 1 to the headline number. `browser-console-test` had the
same problem on arrival and now prints the expected line, so its 84 pages count
as 84.

This cuts against the reflex to treat the total as a coverage measure: it
understates the sweeps and says nothing about what a suite actually asserts.
`page-render-test` is left as it is deliberately, so that the before-and-after
figures in §4 stay comparable rather than jumping by 129 without any more
testing having happened.

## 4. Work completed

**Fixed** · the Purchasing report branch filter (H1); the streamed-error blind
spot in two sweeps (H2); 26 unswept routes (M1); three never-executed suites and
five defective assertions in one of them (M2); one cross-fixture test read (M4);
one test-cleanup abort (L1); one self-inflicted regression (L3).

**Added** · `scripts/streamed-error.ts` (shared failure detector),
`scripts/browser-console-test.ts` (84 pages in a real browser, failing on console
errors, uncaught exceptions and failed requests), `scripts/report-filter-test.ts`
(85 checks — every report crossed with both locations, three periods, four views,
two pages and seven malformed inputs), `scripts/price-moves-test.ts` (14 checks
proving the H1 fix filters correctly), `scripts/dashboard-pages.ts` (one page
list, two consumers).

**Verified sound, with evidence** · money is integer minor units throughout, and
the one `Float` on a money-sounding column is `StockMovement.balanceAfter`, a
quantity, with value held separately as `valueMoved Int`. Document numbers come
from `INSERT … ON CONFLICT DO UPDATE SET value = value + 1 RETURNING value`
inside the transaction, backed by `@@unique([restaurantId, number])` — race-free
with a database backstop. Thirty-seven `SELECT … FOR UPDATE` row locks cover
payments, the accounts ledger, petty cash, cashier, purchasing, receiving, cash
handover, loyalty, transfers, the cash drawer and stock counts, with
`lock_timeout 4s` and `statement_timeout 9s` so a stuck lock cannot hang a
request; the transfer lock carries a written measurement of the race it prevents
(five concurrent dispatches took 50 from a balance of 30 and left it at −20).
Websocket room authorisation refuses a stranger and another tenant's staff while
admitting the guest who placed the order. The PWA scores 19/19: installable
manifest with 192px and 512px icons all served, service worker registers and
activates, and `/offline` is precached and actually served when the network is
cut. All 84 pages load with a silent console — no hydration mismatch, no uncaught
exception, no failed request. All five paginated screens slice their rows. All
seven of QA.md's critical workflows have dedicated suites.

**Gate** · baseline `5185 passed · 0 failed · 3 skipped` → final
`5403 passed · 0 failed · 1 skipped`, and the remaining skip
(`socket-order-room-test`) was run separately against `server.mjs` at 3 passed,
0 failed. Net +218 checks, and three previously invisible suites now execute.
Both figures were measured the same way, before the tally fix in L4; a later run
will read about 83 higher for that reason alone, with nothing more tested.

The browser sweep's own numbers, run directly: **84 pages, 84 passed, 0 failed,
every one with a silent console.**

## 5. Remaining issues

1. **M3, tenant deletion** — needs a decision: a dependency-ordered purge
   routine, or a migration converting the 43 `RESTRICT` constraints. The second
   touches money and stock tables and should not be done casually.
2. **L1, the audit-log SetNull contradiction** — latent while staff removal
   stays soft. If a hard-delete path is ever added it will fail immediately.
3. **Performance has no real evidence behind it** — see §7.
4. **This audit's work is not pushed.** Thirteen files are complete, typechecking
   and green, and deliberately uncommitted; see §8.

## 6. Failed tests

None outstanding. Everything that failed during the audit was either fixed or
explained:

| Suite | Failures | Disposition |
|---|---|---|
| `recorrection-ui-test` | 5 | Defective assertions, corrected (M2). Now 86 passed |
| `report-filter-test` | 12 | Real bug H1, fixed. Now 85 passed |
| `page-render-test` | 1 | Real bug H1, once the detector could see it. Now clean |
| `live-board-test` | 2 | Cross-fixture read, fixed (M4). Now 79 passed |
| `invoices-list-test` | 1 | Self-inflicted (L3), fixed. Now 28 passed |
| 13 suites, one run | 13 | **Environmental, not code.** Postgres hit `max_connections` because several `next start` processes each held a pool. All passed on re-run with connections freed |
| 22 suites, one run | 22 skipped | **Environmental.** The test server was killed by memory pressure mid-gate, silently turning the whole runtime tier into skips while the summary still printed. Worth watching: a gate reporting "1 failed" while 22 suites never ran looks greener than one that fails |

Two environment hazards are worth recording, because both produce a *greener*
result rather than a failure:

- **The test server died twice**, both times killed under memory pressure (three
  sessions, several `next start` processes and Chromium on one machine; free
  memory was down to about 56MB). A dead server turns the runtime tier into
  skips, not failures.
- **Playwright's browser binary disappeared from `~/Library/Caches/ms-playwright`
  part-way through the audit**, after the browser suites had run. Had a gate run
  in that window, all three would have self-skipped and the summary would have
  looked fine. Reinstalled, and the 84-page sweep re-run to confirm.

The common shape: **check the skip count before believing a summary line.**

## 7. Areas not testable, and why

**The six deep-domain audits did not complete.** Money arithmetic, FIFO layer
drift, concurrency interleavings, cash-drawer reconciliation, query performance
and the systematic API-route authorisation table were each delegated to a
parallel agent. All six were stopped part-way through and the work was cancelled,
so none produced findings. They were not relaunched. What replaced them was
targeted spot-checking, which is narrower: it can say "no defect found in what I
read", not "verified". Specifically **not** established:

- whether discount, tax and service charge are applied in the same order at the
  POS, on the invoice, in the stored row and in every report that re-derives them;
- whether split payments must sum to the order total, and whether a refund can
  exceed what was paid or be issued twice;
- whether partial FIFO consumption leaves rounding dust that keeps a layer open;
- an exhaustive read-modify-write survey (the 37 row locks are strong evidence,
  but they are evidence about the paths that have them, not about the ones that
  do not);
- the per-route authenticate / authorise / scope table for all 23 API routes.

These are the areas where a second pass would pay best.

**Performance could not be measured meaningfully.** The largest table in the
local database holds 6,352 rows; `orders` holds 478. Nothing here exercises
scale, so `phase11-perf` and `load-test` passing says little about production.
A static scan for unbounded queries produced 17 candidates and every one I read
turned out to be bounded — by `take`, by a date range, or by a parent relation —
so the scan over-reports and no unbounded-query defect is confirmed. This is the
one rating in §2 driven by absence of evidence rather than evidence.

**Not exercised at all:** realtime reconnect and duplicate-event handling; email
and SMS delivery (SMTP is not configured locally, and the log shows messages
being composed and dropped); payment-gateway callbacks; printing to real
hardware; multi-device concurrent use; and anything requiring production data
volumes.

## 8. Recommendation

**Ship it, with the Purchasing fix, and treat the assurance gaps as the real
finding.**

The product code is in good shape. In a full day of adversarial testing the only
user-facing defect found was H1, and the things that most often go wrong in a
restaurant POS — money precision, document numbering under concurrency, FIFO
valuation, tenant isolation — are not merely correct but deliberately,
defensively correct, with the reasoning written down next to the code.

The concern is H2, and it is worth stating plainly. H1 was not a subtle bug. It
threw on every request, for every tenant, on an empty table, and it did so for
days while the suite designed to catch it reported success 130 times per run. It
was found because someone read a database table, not because a check failed.
Any `force-dynamic` page could have been in the same state. That has been closed,
and the same sweep now demonstrably catches it — but the lesson generalises:
this codebase's static-guard culture is excellent and its *runtime* assurance had
a structural blind spot, and blind spots of that shape are worth hunting
deliberately rather than waiting to trip over.

Before the next release I would: decide on M3; run the five unfinished deep-domain
audits in §7, particularly the money-ordering and split-payment questions;
and get one realistic-volume dataset into a staging database so the performance
rating can be based on something.
