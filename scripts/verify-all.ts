/**
 * Run everything, in one command.
 *
 * The suites had grown to nineteen files run by hand, which meant in practice
 * that only the one being worked on got run. Three stock-corrupting bugs shipped
 * while 636 tests were green, so the cost of a check nobody runs is not
 * hypothetical.
 *
 * Three kinds of check, and the distinction matters:
 *
 *   static   — grep-level guards for bug classes that type-check cleanly and
 *              fail at runtime ('use server' exports, function props crossing
 *              the RSC boundary, unguarded action calls)
 *   service  — the phase suites and QA scenario, against a real database
 *   runtime  — pages and Server Actions over HTTP, which need a built server
 *              and are skipped without one
 *
 * The runtime checks are the ones that caught what everything else missed, so
 * they are reported as SKIPPED rather than passed when no server is running.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/verify-all.ts
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/verify-all.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const BASE_URL = process.env.BASE_URL

/**
 * What a suite needs before it can run at all.
 *
 * ── Why this is written down ────────────────────────────────────────────────
 *
 * Four suites self-skip rather than fail when their dependency is missing,
 * which is the right behaviour: a developer without Playwright's browser
 * installed should not see a red run. The cost is that a SKIP and a PASS look
 * almost the same in a summary line, and the gate could not tell the
 * difference between "you do not have Chromium" and "Chromium was here a
 * minute ago and the suite skipped anyway".
 *
 * That distinction is not academic. A `next start` was killed by memory
 * pressure part-way through a run: twenty-two runtime suites turned into
 * skips, nothing had actually been tested, and the summary read
 * "5040 passed · 1 failed" — greener than a run that fails outright. The
 * existing guard could not catch it, because it only fires when BASE_URL is
 * UNSET, and BASE_URL was set. The server was simply dead.
 *
 * So: preflight probes each dependency, every skip is checked against what
 * preflight found, and a skip nothing explains fails the run.
 */
type Dependency = 'postgres' | 'server' | 'socket' | 'browser'

/**
 * Suites that need more than a database, and what they need.
 *
 * Everything in RUNTIME implicitly needs `server`; this names the extras.
 */
const NEEDS: Record<string, Dependency[]> = {
  'socket-order-room-test': ['server', 'socket'],
  'socket-resilience-test': ['server', 'socket'],
  'recorrection-ui-test': ['server', 'browser'],
  'sidebar-responsive-test': ['server', 'browser'],
  'browser-console-test': ['server', 'browser'],
}

const STATIC = [
  'billing-math-test',
  // acCal.md §2 — the calculator's math: tax round trip, margin vs markup.
  'calc-math-test',
  // bill.md §1 — an enabled receipt row prints at zero; a disabled one is gone.
  'receipt-fields-test',
  'no-bad-server-exports', 'no-function-props', 'no-raw-action-calls',
  'no-unscoped-branch-pages', 'no-unguarded-feature-pages',
  // bugfix.md D15 — every date names its zone: no toLocale*() in the process's zone.
  'no-bare-locale-dates',
  // bugfix.md S10 — an action asks for the split permission its feature sells,
  // never the parent a custom role can hold with the feature switched off.
  'no-parent-permission-actions',
  // A bill's total and what is left on it are each defined once, in
  // features/orders/pricing. Seventeen screens wrote the arithmetic out by
  // hand and three had already lost the clamp, so an overpaid bill showed a
  // negative amount due.
  'no-hand-rolled-money',
  // Every suite shares one database, so a fixture found by a bare phone
  // number or name will one day match a row another suite left behind. That
  // is how live-board-test started failing on a customer that was correct.
  'no-unscoped-fixtures',
  // Every API route declares how it authenticates, the declaration is checked
  // against the file, and the middleware waves through nothing undeclared.
  // The page surface had guards for this; the API surface had none.
  'api-surface-test',
  'no-item-branch-filter',
  // FIFO.md — stock is worth the sum of its layers, never quantity × a blended
  // rate. Thirteen screens did the latter, and since `costPerUnit` is
  // restaurant-wide while the quantity is per branch, not one of them agreed
  // with the layers or with each other.
  'no-average-cost-valuation',
  // production.md §1 — nothing in src may rewrite an append-only record; the
  // database refuses it too, this just fails in CI instead of in front of a user.
  'no-audit-mutation',
  // production.md §6 — offline stays read-only and honest: the service worker
  // caches nothing private, and the offline page promises no sync.
  'no-unsafe-sw-cache',
  // production.md §15/§17 — migrations stay additive and deployable. Reads the
  // SQL, so it costs nothing and belongs with the other grep-level guards.
  'migration-safety-test',
  // Bring-your-own SMS: that an owner's gateway URL cannot reach the private
  // network, that a template cannot break out of its body, that HTTP 200 with
  // an error inside is not a success — and, above all, that `phoneKey` still
  // treats 0771234567 and +94771234567 as two different customers. Pure
  // functions only; the end-to-end lives in scripts/sms-e2e-test.ts, which
  // needs a database and the fake gateway running.
  'sms-test',
  // athu.md — only a credential or deactivation event may write `revokedAt`.
  // A feature-flag edit once logged a whole restaurant out by copying six lines.
  'no-collateral-session-revocation',
  // correctionA.md §3 — one vocabulary for "which period": no third
  // resolveRange, no page starting its window at the current instant, and a
  // selector on every screen that shows figures for a range.
  'range-convergence-test',
  // The transfers export narrowed with `scopeToOne`, which is null for a
  // manager who reaches several branches and has picked none — and a null
  // branch applied no filter at all. Pins the scope, and that screen, paper and
  // file all run through one where-builder.
  'transfer-report-test',
  // Who may rule on what. The rule used to live inline in the approvals page,
  // where a browser was the only way to exercise it.
  'approval-decidability-test',
  // FIFO.md — the walk itself: the spec's worked ladder number for number, and
  // the property that makes it exact, over ten thousand randomised layers.
  // Pure arithmetic, no database.
  'fifo-engine-test',
  // sidebar.md §7 — a favorite or a recent page is only ever an href resolved
  // through the sidebar's own permission filter, so revoking a permission
  // removes the shortcut and no second permission system exists to drift.
  'sidebar-nav-test',
  // Create Role offers exactly the sidebar's entries; a tab carries what it
  // requires (POS → Payment details) on the client and on the server alike;
  // every template round-trips through the boxes unchanged; and "start from
  // scratch" is based on something the edge lets into every tab that is on.
  'sidebar-access-test',
]

const SERVICE = [
  'qa-suite',
  'phase1-test', 'phase2-test', 'phase3-test', 'phase4-test', 'phase5-test',
  'phase6-test', 'phase7-test', 'phase8-test', 'phase9-test', 'phase11-test',
  // Two tills reaching for one bill with DIFFERENT idempotency keys — the
  // race a replay check cannot save, where only the row lock stands between
  // the restaurant and a double-settled order. payment-model-test covers the
  // same-key replay; phase11-test covers the inventory side.
  'concurrency-test',
  // Removing a tenant, against one that has actually been traded in. The
  // documented "remove a tenant's data on request" did not work: 43 RESTRICT
  // foreign keys mean a plain DELETE fails on whichever it reaches first.
  'tenant-purge-test',
  'storage-stock-test', 'connection-url-test', 'action-transport-test',
  'staff-login-test', 'order-lifecycle-test', 'cogs-test',
  // A waiter takes the order at the table and it reaches the kitchen with no
  // cashier in the way: ACCEPTED on placement, routed, depleted, on the rail,
  // joining the table's open sitting, and idempotent against a double tap.
  'waiter-order-test',
  // The transfer report and the live tables screen read what they claim to:
  // one where-builder behind screen, paper and file, and a branch the viewer
  // cannot reach returns nothing.
  'transfer-lines-test',
  // The sales report shows one breakdown at a time, and an item's drill-down
  // reports the BILLS it was on — a payment settles a bill, and nothing
  // divides one across its lines.
  'sales-views-test',
  // The sales screen's tiles and drill-downs. A discount belongs to a BILL, so
  // showing one per item or per hour divides it — and a division that rounds is
  // a division that can lose money. Pins that every bill's shares add back to
  // that bill's discount, and each column back to the tile above it.
  'sales-detail-test',
  // The Purchasing report's price history, which reaches a branch only
  // through the goods receipt that recorded it. `report-filter-test` pins
  // that the page stops throwing; an empty table cannot tell a working
  // filter from one that silently returns nothing, so this gives it two
  // branches and two prices and checks the trend it draws.
  'price-moves-test',
  // Purchasing. A purchase REQUEST is not a purchase — a rejected request is
  // not cancelled spending and a draft is not committed money — and the
  // "variance" tile is committed against ACTUAL, since this system has no
  // budget: what the order said, against what the delivery was invoiced at.
  'purchasing-report-test',
  // FIFO.md — the books tie to the layers after purchase, sale, wastage,
  // adjustment, transfer and reversal: layer quantity equals what the branch
  // holds, layer value equals the item's value, and every movement's trace
  // sums to what the movement was worth.
  'fifo-invariants-test',
  // Stock in at a price the item does not already carry: the new price makes
  // its own layer, stays invisible behind older stock, and takes over only
  // once that runs out. Before the price field existed an inbound adjustment
  // was valued at the item's current cost, so a price rise never reached the
  // books — this is what fails if that returns.
  'stock-in-price-test',
  // FIFO.md — "the destination receives the same cost layers": a transfer
  // hands over one layer per source layer, at their values and their ORIGINAL
  // receipt dates, so the stock keeps its place in the queue at the far end.
  'fifo-transfer-test',
  // FIFO.md — a return to supplier is the undoing of a receipt, not an issue
  // of stock: the goods go back off the delivery that brought them, so what
  // leaves inventory is what the supplier credits. Drawing oldest-first booked
  // the price difference as a profit on sending goods back.
  'fifo-returns-test',
  // Menu codes, the waiter's table rules, delivery locations and the offers
  // panel: a code names one dish, a reserved or settling table refuses an
  // order (an ordinary second round does not), a place belongs to one branch
  // and one category, and the panel never advertises an offer the engine
  // would refuse.
  'waiter-qr-flow-test',
  // The delivery desk: ready deliveries, and the PIN that closes one. The
  // desk is never sent the PIN, a wrong guess is counted and refused, and a
  // second tap cannot complete an order twice.
  'delivery-desk-test',
  // The deadlock retry on the handover, by injecting a 40P01 rather than
  // racing for one. Control flow that only runs under a race nobody can
  // reproduce on demand is control flow nothing checks — it shipped that way.
  'delivery-retry-test',
  // An offer aimed at a customer category reaches that customer without them
  // typing anything — the whole point of aiming it — while a public code
  // stays a code. Pins the delivery QR, which is where it was first noticed.
  'targeted-offer-test',
  // bank.md — internal accounts. The balance is not stored, it is the history
  // summed, so these pin that every way money can move lands there exactly
  // once: a deposit, both halves of a transfer or neither, and a customer
  // payment that moves the balance WITHOUT writing a second row for itself.
  'payment-account-test',
  'negative-stock-test', 'reconciliation-test', 'production-ready-test',
  'stock-location-test',
  'branch-scope-test',
  // staff.A.md §3/§4/§6/§10 — per-staff allow and deny, several branches per
  // person, the POS rename across all six persisted columns, and the
  // POS_OPEN_DRAWER split.
  'staff-access-test',
  // pro.A.md §4/§10 — a targeted offer reaches the till from a phone number,
  // points are spendable both at placement and on an open bill, and the ledger
  // still explains the balance afterwards.
  'pos-offers-test',
  // stockMa.md — the stock keeper: what they may and may not do, that they see
  // one location and nothing without one, and that a correction they raise
  // moves no stock until somebody else signs it.
  'stock-keeper-test',
  // loyalty — a rewards catalogue on top of the existing ledger: spending one
  // is atomic and happens once, refusals explain themselves, cancelling and
  // refunding unwind it, and every path leaves the balance equal to the sum
  // of its entries.
  'loyalty-rewards-test',
  'instructions-test',
  // redesignkitchenjob.md — prepared items: one-step Make Item, exact value
  // carried from raw stock into the prepared item, waste expensed separately,
  // idempotent completion, and production → recipe → sale → COGS exactly once.
  // Replaced the recipe-driven job suites of the kitchenjobs.md era.
  'prepared-items-test',
  // correctionA.md §10 — a batch can be started before its yield is known:
  // starting moves nothing, finishing runs the same atomic transaction against
  // the same reference number, and the planned figure survives so the variance
  // is real.
  'production-yield-test',
  // recorrection.md §3 — one flow: Create writes the prepared item and its
  // recipe and moves nothing; Mark Done consumes the plan under the batch's
  // own number (no fresh PRD- drawn, none skipped); the recipe is kept when
  // the plan is identical and versioned when it changes; unit, self-reference
  // and raw-name mistakes are refused at Create; the form has one verb.
  'prepared-item-test',
  // aO.md §5 — the item page's data, Make Done in the unit it was measured
  // in, Make More scaling the recipe in one step and replaying on its key,
  // and a history that keeps in-progress and cancelled runs with what each
  // consumed.
  'production-flow-test',
  // pro.b.md §4/§5/§7/§18 — the six-step flow: creating an order moves
  // nothing; issuing draws the oldest lots first at each lot's own price and
  // records which; completion costs the actual output from what was issued
  // and stocks it at this branch only; the second tap of anything is refused.
  'production-fifo-test',
  // ar.md — QR menus as a configuration layer: a code created with a name and
  // a branch behaves exactly as the old QR did; a menu-only code seats nothing
  // and orders nothing; category-specific questions are asked and irrelevant
  // ones are not; an existing customer keeps their name through the gate AND
  // through placeOrder; a QR-scoped offer is refused at the till.
  'qr-experience-test',
  'catalog-test',
  'purchasing-test',
  // PO request → approval → approved PO → receive/GRN → FIFO: a request is
  // returned or rejected only with a reason and decided through the desk
  // (no self-approval), nothing is received against anything but an approved
  // order, a partial delivery leaves the rest outstanding, one more than
  // ordered is refused, and each delivery is its own FIFO layer valued at what
  // was paid — with the price variance recorded, not written onto the PO.
  'po-workflow-test',
  // The approvals desk: four tabs by what is being asked for, and a request
  // is in Pending until it is decided and in Record from the moment it is —
  // never both, never neither. Also that a submitted PO is on the desk ONCE,
  // now that submitting raises an approval request as well as setting the
  // order's status.
  'approvals-desk-test',
  // The Inventory Reports screen against the ledger it reads: value is the
  // sum of the layers (not a blended rate), the categories add back to the
  // total, the trend ties to the ledger at both ends, opening + in − out =
  // closing per item, transfers are their own bucket rather than an in and
  // an out, and a branch filter narrows both value and movement.
  'inventory-report-test',
  'supplier-ledger-test',
  'search-test',
  'locations-test',
  'branch-isolation-test',
  // production.md §5 — the outbox commits with the work it describes, so a
  // realtime failure cannot lose an order; and a reconnecting screen catches up.
  'realtime-recovery-test',
  // production.md §13 — the queue claims without doubling up, backs off, stops,
  // and never sweeps away a failure.
  'jobs-test',
  // The database watcher's judgement on fixtures, without a key: the invoice
  // reminder window, a quota about to refuse connections (2026-09-27), a
  // disabled endpoint, the app pointed at a project nobody watches, and that
  // an alert is announced once and not every hour.
  'neon-watch-test',
  // A delivery QR order is accepted on the till's Delivery tab through the
  // till's own accept — the plain status change refuses it, which is the bug
  // the Delivery tab's button hit — and the cashier's list leaves it out.
  'delivery-accept-test',
  // The Payment details report adds up to the account balances, and a
  // staff member sees only the accounts the owner gave them.
  'payment-report-test',
  // production.md §14 — TOTP against the RFC vector, encrypted at rest,
  // single-use recovery codes.
  'mfa-test',
  // prisma/email.md — forgot password by emailed code: an unknown address
  // behaves exactly like a known one, the code is stored only as a keyed
  // hash, five wrong guesses lock it, the grant is single-use even under a
  // race, every session is revoked, and a provider outage refuses everyone
  // alike.
  'password-reset-test',
  // athu.md — the refresh-token rotation race, run AS a race: two tabs
  // refreshing one token must both keep a session. Plus grace, lineage,
  // daily rotation, scope lifetimes and the second-factor gate.
  'session-lifecycle-test',
  // production.md §3 — the tenant boundary swept the way branches already are;
  // cross-restaurant checks used to be four one-line asides in other suites.
  'tenant-isolation-test',
  // production.md §1/§17 — the money and stock constraints refuse bad rows at
  // the database, not just in the service that normally writes them.
  'db-constraint-test',
  'dashboard-period-test',
  'role-permissions-test',
  'access-links-test',
  // Role links — one link per role that everybody on it signs in through with
  // their own code, and the escape that lets a second person reach the login
  // form on a shared till.
  'role-link-test',
  'pos-billing-test',
  // AUDIT.md Slice 2 — tips, refund rows, discount split, counters, loyalty ledger.
  'payment-model-test',
  // bill.md §2 — money is allocated to an account, splits carry their own,
  // refunds go back where they came from, and renaming never rewrites history.
  'payment-destination-test',
  // bill.md §3/§4 — two approvers cannot both win, a refusal carries its
  // reason, and a branch manager sees the restaurant-wide requests too.
  'approvals-decision-test',
  // AUDIT.md Slice 3 — option consumption, value-carrying WAC, branch guards.
  'inventory-truth-test',
  // AUDIT.md Slice 4 / §102 — every screen answers with the same number.
  'report-agreement-test',
  // AUDIT.md Slice 5 — sessions, apportionment, invoices-at-presentation,
  // the daily close and sealed periods.
  'structural-test',
  // AUDIT.md Slice 6 — the integrity checker and shared rate limits.
  'hardening-test',
  // accountsds.md — the accountant's money-out workflow and its guards.
  'accounting-module-test',
  // accountsds.md §16 — PO → GRN → payable → approval → paid → reconciled.
  'e2e-accountant-test',
  // acCal.md §3/§18 — every explanation folds to its value; no invented numbers.
  'explain-test',
  // bill.md §1 — the bill settings persist, and neither settings form can
  // erase the other's column.
  'receipt-settings-test',
  // acCal.md §9 — the derived journal balances and ties to every engine.
  'ledger-test',
  // acCal.md §6 — statement import, matching rules, duplicates, races.
  'bank-rec-test',
  // acCal.md §13 — the month-end checklist answers from the records.
  'month-close-test',
  // acCal.md §12 — the price simulator's maths, and that it writes nothing.
  'what-if-test',
  // smart.md — usage/days-remaining/reorder maths, menu matrix, health score,
  // per-dish profit rows, waste by category, the anomaly checks; writes nothing.
  'insights-test',
  // AUDIT.md Slice 7 — the §101 worked example, end to end, and the billing
  // engine's own matrix.
  'e2e-reconciliation-test',
  'variant-order-test',
  'custom-domain-test',
  // bugfix.md — the 2026-09-13 audit's money, data and security defects, each
  // reproduced (races run as races) and pinned against the fix.
  'bugfix-money-test',
  'bugfix-security-test',
  // websiteconnect.md — a restaurant's website connects with a key, reads only
  // its own data, and its orders land in the existing pipeline.
  'website-connection-test',
  'cash-drawer-test',
  'role-assignment-test',
  'branch-isolation-2-test',
  'stock-count-branch-test',
  'expiry-tracking-test',
  'staff-attendance-test',
  'live-board-test',
  // abc.md §3 — a table is Empty, Occupied or Reserved: an order seats it,
  // settling or cancelling the last order frees it (Empty, not Cleaning),
  // Reserved is derived from a booking's window and never stored.
  'table-state-test',
  // abc.md §4 — a booking stores its end; two bookings cannot hold one table
  // at once ([start, end) — neighbours are fine); the party must fit; a
  // cancelled booking blocks nothing; the first order seats the booked party.
  'reservation-conflict-test',
  // abc.md §3 — a sitting moves to an empty table with its orders, bill and
  // customer intact; the target must be free (no sitting, no order, no
  // booking in window, same site, in service); the source is Empty after.
  'table-swap-test',
  // abc.md §6 — a line's prepared / served counters by quantity: forward
  // only, served ≤ prepared ≤ quantity, the order follows its lines, the
  // cascades carry the counters, a split keeps made plates with the
  // original, and the floor reads Ordered / Prepared / Served / Remaining.
  'item-progress-test',
  // abc.md §5 — a QR / online order waits at the till: off the kitchen rail
  // and counts until the cashier accepts it (one gate in the service), reject
  // is a cancellation with a reason, the cashier is told on placement.
  'cashier-accept-test',
  // aO.md §2 — a QR guest orders only at a table that is theirs: a stranger's
  // open order or sitting is "in use", a booking in its window is reserved
  // until seated, the party at the table may order again; a bill paid before
  // the food came does not empty the table — being served does, by itself.
  'table-availability-test',
  // aO.md §3 — a guest adds NEW dishes from the menu to their existing order:
  // priced at the order's branch, routed and taken off stock only once the
  // kitchen has the order, totals re-derived, history kept, own session only.
  'guest-add-items-test',
  // order editing — the till's door onto the same core: adding to a dine-in,
  // takeaway or counter order routes and re-totals at once; cancelling a
  // dish keeps it on the kitchen ticket crossed out; a paid bill refuses
  // both; and the two doors are one function.
  'order-edit-test',
  // abc.md §7 — a waiter call is one event per table and need (a partial
  // unique index, not a timer), acknowledged then resolved with who and
  // when, waiters and management told at the table's branch, history per site.
  'waiter-call-test',
  // abc.md §1 — the orders list: period, filters, 50 / 100 / All, and
  // totals from the rows' own predicate; the export's 500 a page honoured.
  'orders-list-test',
  // abc.md §2 — the invoices list: period, status, rows per page, totals
  // from one predicate through the order's branch and payment status.
  'invoices-list-test',
  'recipe-costing-test',
  'input-stability-test',
  'kitchen-routing-test',
  'menu-station-test',
  'cash-drawer-flow-test',
  // correctionA.md §4 — the cashier counts notes and is shown neither the
  // expected cash nor the gap until the close is committed; the total is
  // derived on the server from face values the currency actually has.
  'drawer-denomination-test',
  // correctionA.md §11 — a till is offered to one person at a time, and the
  // handover history is shown to the people entitled to read it: a manager
  // sees the floor's, a cashier only the ones they were part of.
  'handover-flow-test',
  // recorrection.md §2 — a shift handover for every role: who may take over
  // from whom, the guards (self, role, site, one in flight each way, tenant),
  // accept/reject-with-reason/withdraw, the till nested inside a cashier's
  // (confirm requests it, accept takes it, reject declines it, withdraw
  // re-opens the outgoing drawer), notifications, participant-scoped history.
  'shift-handover-test',
  // shifthandover.md — templates, the rota, starting a rostered shift, the
  // blind till count, and accept ending the shift.
  'shift-management-test',
  'feature-access-test',
  // correctionA.md §5/§6/§7 — every screen names the location it is acting on
  // (including the one-location case, where the switcher renders no menu), and
  // a transfer moves stock between two locations rather than between shelves.
  'branch-context-test',
  // correctionA.md §9 — an empty approver list means "the permission decides",
  // not "nobody"; an override only counts when a rule was actually in the way,
  // and the row says so afterwards; From/To filter both directions and neither
  // can widen what somebody may see.
  'approval-access-test',
  // recorrection.md §1 — deciding is gated on the permission for the KIND of
  // request, not settings.manage; an owner is bound by no branch's approver
  // list and may sign their own (marked forced); a decision and its
  // consequence are one transaction; the desk shows a transfer's lines to
  // both ends; filters narrow the pending desk; write-offs are on it; the
  // approver list is written compare-and-swap.
  'approval-desk-test',
  // recorrection.md §1 — transfers are pulled: the destination requests, the
  // source approves and dispatches, the destination receives; the list files
  // by status and by the viewer's side; the transfer page no longer decides.
  'transfer-direction-test',
  // correctionA.md §2 — a task can name a person, the posted id is checked
  // against the caller's own restaurant before it is stored, and the nav badge
  // counts what is mine rather than what is on a colleague's plate.
  'task-assignment-test',
  // sidebar.md §1/§9 — favorites are per user and per restaurant, refused on
  // write for a page the person may not open, and carried on the select the
  // session already runs so the sidebar costs no query to draw.
  'sidebar-favorites-test',
  // production.md §4 — cold single-call latency against 20k orders, thresholded.
  // It existed and was never registered, so `npm run verify` never ran it.
  'phase11-perf',
  // production.md §4 — the same paths under concurrent load, reporting
  // p50/p95/p99, error rate, connections and memory. Small defaults so it fits
  // in a verify run; LOAD_CONCURRENCY / LOAD_SECONDS turn it up for a real one.
  'load-test',
]

const RUNTIME = [
  'page-render-test', 'action-e2e-test', 'qr-to-kitchen-test',
  // A delivery guest's whole journey over HTTP: scan, order, then the tracker
  // and the bill under /m/<code>, with no tenant cookie anywhere. Pins the 404
  // that shipped twice because nothing walked past the checkout.
  'qr-delivery-journey-test',
  // abc.md §8 — /cashier redirects into the POS; tabs by permission.
  'pos-shell-test',
  // bugfix.md — the staff-codes page per branch, the pulse stream confined,
  // uploads checked by signature, cross-tenant writes through real actions.
  'security-runtime-test',
  // pro.A.md §19 — editing a stock item actually writes to the database,
  // the cost rule refuses instead of silently dropping, and the edit is audited.
  'inventory-edit-test',
  // staff.A.md §3/§6 — the real actions over real HTTP: opening a till refused
  // without the permission, a denial landing on the same cookie with no
  // re-login, and escalation refused on the grant half only.
  'pos-drawer-test',
  // websiteconnect.md — the website API over real HTTP: key refused and accepted,
  // menu priced per branch, an order that lands ONLINE, a browser call refused.
  'website-api-test',
  // AUDIT.md C1/H10/H11 — a guest edit must hit kitchen, bill and stock alike.
  'guest-edit-test',
  'role-url-refusal-test', 'join-flow-test', 'cashier-gate-test',
  // Create Role over HTTP: the sent list is closed over its dependencies, the
  // staff named are connected (role = access, location = where), refusals
  // (inactive, other tenant, other site, impossible pair) leave no role
  // behind, and a person it connected is served the tabs and refused the rest.
  'role-create-test',
  // The PO workflow over HTTP as the buyer, the approver and the storekeeper:
  // who may raise, decide and receive; a decision from the wrong person, site
  // or restaurant refused with nothing written; a partial delivery at the
  // invoice price making a FIFO layer worth what was paid; every step audited.
  'po-flow-runtime-test',
  // Every guarded route asked without a caller: never 200, never 5xx, and
  // nothing sensitive in the refusal. Found an authorization failure being
  // reported as HTTP 500 with the raw error text.
  'api-authorization-test',
  // Needs a served route: it asks the running app what its change-token says.
  'pulse-scope-test',
  // Every report crossed with every filter the toolbar can set, on a tenant
  // with two locations — the only shape where choosing one narrows anything.
  // `page-render-test` sweeps each page with `?branch=` too, but as whichever
  // owner comes first, and most tenants here have a single site; the
  // Purchasing report threw for every multi-location tenant while that sweep
  // stayed green.
  'report-filter-test',
  // The approvals desk and the transfers board still SAY what the browser test
  // looks for. `recorrection-ui-test` owns that contract and needs Playwright's
  // browser; this checks the same text over plain HTTP, so the contract does
  // not quietly lapse wherever that browser is not installed.
  'approvals-render-test',
  // recorrection.md §1/§4 — the task picker scrolls under the wheel inside its
  // dialog and names role and location; the pending desk opens details and
  // approves from the dialog; the transfer form locks TO for a confined
  // manager; each end's list files the transfer by their side.
  'recorrection-ui-test',
  // athu.md — the refresh race over real HTTP with a cookie jar: two tabs on
  // one day-old token both stay signed in; Set-Cookie attributes; prefetch
  // exclusion; /logout fetch-metadata; sign-in with the second factor.
  'session-runtime-test',
  // Skips itself unless the server carries Socket.IO (`node server.mjs`).
  'socket-order-room-test',
  // What the live stream does when the connection is not perfect. Restaurant
  // wifi drops constantly, so "interrupted" is the normal case: the stream
  // must resume, one event must arrive once per device however many times a
  // client re-joins, and a reconnected socket must NOT be silently still in
  // its old room — which is why a client resyncs rather than trusting it.
  'socket-resilience-test',
  // correctionA.md §1 — every type the UI offers is one the route answers, in
  // both formats, and report.export alone opens none of them: each still needs
  // the permission that guards the screen it comes from.
  'export-coverage-test',
  // sidebar.md §5/§8 — the rail, the drawer and the collapse measured in a real
  // browser at three widths. Both surfaces render the same component, so the
  // markup is identical at every size and only computed CSS can tell them apart.
  'sidebar-responsive-test',
  // The same page list `page-render-test` sweeps, opened in a browser instead
  // of fetched. That one proves the server rendered; this one proves the page
  // still works once its JavaScript runs — a hydration mismatch, a throwing
  // effect or a 500 from a route a panel calls all return a clean 200 and are
  // visible only in the console.
  'browser-console-test',
]

interface Outcome {
  name: string
  kind: string
  passed: number
  failed: number
  skipped: boolean
  /**
   * The lines that actually failed.
   *
   * Without these a red row said "1 FAILED" and nothing else, so the only way
   * to learn WHICH check broke was to re-run the suite by hand — and a suite
   * that only fails as part of the whole run (accumulated data, ordering) is
   * exactly the one that will then pass on its own.
   */
  detail: string[]
}

function run(name: string, kind: string): Outcome {
  let out = ''
  let crashed = false
  try {
    out = execFileSync(
      'npx',
      ['tsx', '--tsconfig', 'tsconfig.test.json', `scripts/${name}.ts`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    )
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    out = (e.stdout ?? '') + (e.stderr ?? '')
    crashed = true
  }

  if (/skipping\./i.test(out)) return { name, kind, passed: 0, failed: 0, skipped: true, detail: [] }

  const lines = out.split('\n')
  const detail = lines
    .map((line, index) => (line.includes('✗') ? lines.slice(index, index + 3).join('\n') : null))
    .filter((line): line is string => line !== null)
    .slice(0, 5)

  const tally = out.match(/(\d+) passed, (\d+) failed/)
  if (tally) {
    return { name, kind, passed: Number(tally[1]), failed: Number(tally[2]), skipped: false, detail }
  }
  // A guard script reports by exit code and a single line.
  if (!crashed && /✓/.test(out)) return { name, kind, passed: 1, failed: 0, skipped: false, detail }
  return {
    name, kind, passed: 0, failed: 1, skipped: false,
    detail: detail.length ? detail : [out.trim().split('\n').slice(-12).join('\n')],
  }
}

/** Is this dependency actually there, right now? */
async function probe(what: Dependency): Promise<boolean> {
  switch (what) {
    case 'postgres': {
      const { prisma } = await import('../src/server/db/prisma')
      try {
        await prisma.$queryRaw`SELECT 1`
        return true
      } catch {
        return false
      } finally {
        // Held only for the probe: several servers each keeping a pool is how
        // this database ran out of connections mid-run once already.
        await prisma.$disconnect().catch(() => undefined)
      }
    }
    case 'server': {
      if (!BASE_URL) return false
      /*
       * Three tries. A single failed fetch is not proof of death — the server
       * may simply be busy finishing the request a suite just made — and this
       * probe decides whether to call the whole run invalid, so a false
       * positive costs as much as a missed one. It cried wolf exactly once
       * before the retries were here.
       */
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const alive = await fetch(BASE_URL, { redirect: 'manual' }).then(() => true).catch(() => false)
        if (alive) return true
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      return false
    }
    case 'socket': {
      if (!BASE_URL) return false
      // A plain `next start` serves no Socket.IO; `node server.mjs` does.
      return fetch(`${BASE_URL}/socket.io/?EIO=4&transport=polling`)
        .then((response) => response.ok)
        .catch(() => false)
    }
    case 'browser': {
      try {
        const { chromium } = await import('playwright')
        const path = chromium.executablePath()
        return Boolean(path) && existsSync(path)
      } catch {
        return false
      }
    }
  }
}

async function preflight(): Promise<Set<Dependency>> {
  console.log(`\n── preflight ${'─'.repeat(50)}`)
  const available = new Set<Dependency>()
  for (const what of ['postgres', 'server', 'socket', 'browser'] as const) {
    const ok = await probe(what)
    if (ok) available.add(what)
    const note =
      what === 'server' && !BASE_URL ? 'no BASE_URL set'
        : what === 'socket' && !ok ? 'plain next start serves none; run node server.mjs'
          : what === 'browser' && !ok ? 'run npx playwright install chromium'
            : ''
    console.log(`  ${ok ? '✓' : '·'} ${what.padEnd(10)} ${ok ? 'available' : `unavailable${note ? ` — ${note}` : ''}`}`)
  }

  /*
   * Reachable is not the same as usable.
   *
   * A run needs roughly one pool per suite process, and this database has
   * been exhausted mid-run four times — by servers killed without closing
   * their pools, leaving backends that Postgres still counts as connected.
   * The symptom is a scatter of `PrismaClientInitializationError` across
   * unrelated suites, which reads as thirty-two broken features rather than
   * as one environment with no room left. Checking the headroom up front
   * turns an hour of confusion into a sentence.
   */
  if (available.has('postgres')) {
    const { prisma } = await import('../src/server/db/prisma')
    try {
      const [room] = await prisma.$queryRaw<Array<{ used: bigint; limit: string }>>`
        SELECT (SELECT count(*) FROM pg_stat_activity) AS used,
               current_setting('max_connections')      AS limit
      `
      const used = Number(room.used)
      const limit = Number(room.limit)
      const free = limit - used
      const ok = free >= 20
      console.log(`  ${ok ? '✓' : '·'} headroom   ${used}/${limit} connections used, ${free} free`)
      if (!ok) {
        console.log('\n  Fewer than 20 connections are free. Suites will fail on connection')
        console.log('  errors that have nothing to do with the code. Close other servers, or')
        console.log('  clear backends left behind by killed ones:\n')
        console.log("    SELECT pg_terminate_backend(pid) FROM pg_stat_activity")
        console.log("     WHERE datname = current_database() AND pid <> pg_backend_pid()")
        console.log("       AND state = 'idle' AND now() - state_change > interval '20 minutes';\n")
        await prisma.$disconnect().catch(() => undefined)
        process.exit(1)
      }
    } finally {
      await prisma.$disconnect().catch(() => undefined)
    }
  }

  /*
   * Postgres is not optional for anything. Without it every service suite
   * fails for the same uninteresting reason, and the run tells you nothing
   * about the code.
   */
  if (!available.has('postgres')) {
    console.log('\n  Postgres is unreachable. Every service suite would fail for that reason')
    console.log('  alone and the run would say nothing about the code. Fix DATABASE_URL first.\n')
    process.exit(1)
  }

  /*
   * Setting BASE_URL is a statement of intent: the caller wants the runtime
   * tier. If it is set and nothing answers, the runtime suites would all skip
   * and — because preflight had recorded the server as absent — every one of
   * those skips would be classified EXPECTED and the run could go green
   * having tested none of them. That is the same false comfort as the dead
   * server, arriving by a different door, so it fails here instead.
   */
  /*
   * The server must be serving THIS build.
   *
   * Running the gate from one tree against a server built from another is a
   * mistake that does not look like one: the pages render, the database is
   * shared, and only the suites that invoke Server Actions fail — with
   * "Failed to find Server Action", sixty-five times, scattered across seven
   * suites that appear to have nothing in common. It cost an hour to
   * recognise. Next writes its build id into the HTML, so the two can simply
   * be compared.
   */
  if (available.has('server')) {
    const localId = existsSync('.next/BUILD_ID')
      ? readFileSync('.next/BUILD_ID', 'utf8').trim()
      : null
    if (localId) {
      const html = await fetch(`${BASE_URL}/login`).then((r) => r.text()).catch(() => '')
      if (html && !html.includes(localId)) {
        console.log(`\n  The server at ${BASE_URL} is serving a DIFFERENT build.`)
        console.log(`  This tree built ${localId}, and that server does not mention it.`)
        console.log('  Server Action ids are per-build, so the action suites would fail in a')
        console.log('  way that looks like broken code rather than a mismatched server.')
        console.log('  Rebuild and restart, or run the gate from the tree that built it.\n')
        process.exit(1)
      }
      console.log(`  ✓ build      ${localId} — the server is serving this tree`)
    }
  }

  if (BASE_URL && !available.has('server')) {
    console.log(`\n  BASE_URL is set to ${BASE_URL} and nothing answers there.`)
    console.log('  That asks for the runtime tier and then cannot run it. Start the server,')
    console.log('  or unset BASE_URL to run the static and service tiers on their own.\n')
    process.exit(1)
  }
  return available
}

async function main() {
  const available = await preflight()
  const results: Outcome[] = []

  for (const [list, kind] of [[STATIC, 'static'], [SERVICE, 'service'], [RUNTIME, 'runtime']] as const) {
    console.log(`\n── ${kind} ${'─'.repeat(58 - kind.length)}`)
    for (const name of list) {
      const outcome = run(name, kind)
      results.push(outcome)
      const label =
        outcome.skipped ? 'SKIPPED — no server'
          : outcome.failed > 0 ? `${outcome.passed} passed, ${outcome.failed} FAILED`
            : `${outcome.passed} passed`
      const mark = outcome.skipped ? '·' : outcome.failed > 0 ? '✗' : '✓'
      console.log(`  ${mark} ${name.padEnd(26)} ${label}`)
      // Say WHICH check broke, here, while the run is in front of somebody.
      for (const line of outcome.failed > 0 ? outcome.detail : []) {
        console.log(line.split('\n').map((part) => `      ${part.trim()}`).join('\n'))
      }
    }
  }

  const passed = results.reduce((n, r) => n + r.passed, 0)
  let failed = results.reduce((n, r) => n + r.failed, 0)
  const skipped = results.filter((r) => r.skipped)

  /*
   * Did the server survive the run?
   *
   * If it was up at preflight and is down now, every runtime skip after the
   * moment it died is an infrastructure failure wearing a skip's clothes, and
   * the suites underneath were never executed. This is the exact shape that
   * once reported "5040 passed · 1 failed" while twenty-two suites had not
   * run at all.
   */
  const serverDiedMidRun = available.has('server') && !(await probe('server'))
  if (serverDiedMidRun) available.delete('server')

  /** A skip is expected only when preflight said the thing it needs is absent. */
  const missingFor = (name: string): Dependency[] => {
    const needs = NEEDS[name] ?? (results.find((r) => r.name === name)?.kind === 'runtime' ? ['server'] : [])
    return (needs as Dependency[]).filter((need) => !available.has(need))
  }
  const expected = skipped.filter((r) => missingFor(r.name).length > 0)
  const unexpected = skipped.filter((r) => missingFor(r.name).length === 0)

  console.log(`\n${'═'.repeat(62)}`)
  console.log(
    `  ${passed} passed · ${failed} failed · ` +
    `${expected.length} expected skip · ${unexpected.length} unexpected skip`,
  )

  if (expected.length > 0) {
    console.log('\n  Skipped, and preflight says why:')
    for (const outcome of expected) {
      console.log(`    · ${outcome.name.padEnd(26)} needs ${missingFor(outcome.name).join(', ')}`)
    }
  }

  if (serverDiedMidRun) {
    console.log(
      '\n  ✖ INFRASTRUCTURE: the server answered at preflight and does not now.\n' +
      '    It died part-way through, so the runtime suites below it never ran.\n' +
      '    Nothing about this run is evidence either way. Restart it and run again.',
    )
    failed += 1
  }

  if (unexpected.length > 0) {
    console.log('\n  ✖ UNEXPECTED SKIPS — everything these need was available:')
    for (const outcome of unexpected) {
      console.log(`    ✗ ${outcome.name}`)
    }
    console.log(
      '\n    A suite that skips with its dependencies present is not coverage.\n' +
      '    Either it is looking for the wrong thing, or it needs something\n' +
      '    nobody has written into NEEDS at the top of this file.',
    )
    failed += 1
  }

  /*
   * The runtime tier is MANDATORY (§121, AUDIT.md slice 7). It exits green
   * when skipped for months, and the three stock-corrupting bugs that shipped
   * under 636 green tests all lived in the seam it covers. A run without it
   * now FAILS, unless the caller says in so many words that they know:
   * SKIP_RUNTIME=1 is for quick service-tier iteration, never for sign-off.
   */
  const runtimeSkipped = results.some((r) => r.kind === 'runtime' && r.skipped)
  if (runtimeSkipped && !BASE_URL) {
    console.log(
      '\n  The runtime checks were SKIPPED — and they are the ones that catch a\n' +
      '  page or action that fails only when actually served:\n' +
      '    npx next build && npx next start -p 3210 &\n' +
      '    BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/verify-all.ts',
    )
    if (process.env.SKIP_RUNTIME === '1') {
      console.log('\n  SKIP_RUNTIME=1 — treating that as deliberate. Not a sign-off run.\n')
      process.exit(failed === 0 ? 0 : 1)
    }
    console.log('\n  A verify run without the runtime tier is not a pass. (SKIP_RUNTIME=1 to waive, deliberately.)\n')
    process.exit(1)
  }
  /*
   * A machine-readable copy, for `release-gate.ts`.
   *
   * A release gate must be able to assert that a NAMED suite actually ran,
   * not merely that the total looked healthy — the whole lesson of the dead
   * server is that a summary line cannot distinguish "passed" from "never
   * executed". Parsing this console output would work until somebody changes
   * a word in it, so the outcomes are written out as data instead.
   */
  if (process.env.VERIFY_REPORT) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      process.env.VERIFY_REPORT,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          baseUrl: BASE_URL ?? null,
          available: [...available],
          passed,
          failed,
          expectedSkips: expected.map((r) => r.name),
          unexpectedSkips: unexpected.map((r) => r.name),
          serverDiedMidRun,
          suites: results.map((r) => ({
            name: r.name,
            kind: r.kind,
            passed: r.passed,
            failed: r.failed,
            skipped: r.skipped,
          })),
        },
        null,
        2,
      ),
    )
    console.log(`\n  report written to ${process.env.VERIFY_REPORT}`)
  }

  console.log()
  process.exit(failed === 0 ? 0 : 1)
}

main()
