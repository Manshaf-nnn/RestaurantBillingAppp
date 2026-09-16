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

const BASE_URL = process.env.BASE_URL

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
  'no-item-branch-filter',
  // production.md §1 — nothing in src may rewrite an append-only record; the
  // database refuses it too, this just fails in CI instead of in front of a user.
  'no-audit-mutation',
  // production.md §6 — offline stays read-only and honest: the service worker
  // caches nothing private, and the offline page promises no sync.
  'no-unsafe-sw-cache',
  // production.md §15/§17 — migrations stay additive and deployable. Reads the
  // SQL, so it costs nothing and belongs with the other grep-level guards.
  'migration-safety-test',
  // athu.md — only a credential or deactivation event may write `revokedAt`.
  // A feature-flag edit once logged a whole restaurant out by copying six lines.
  'no-collateral-session-revocation',
  // correctionA.md §3 — one vocabulary for "which period": no third
  // resolveRange, no page starting its window at the current instant, and a
  // selector on every screen that shows figures for a range.
  'range-convergence-test',
  // sidebar.md §7 — a favorite or a recent page is only ever an href resolved
  // through the sidebar's own permission filter, so revoking a permission
  // removes the shortcut and no second permission system exists to drift.
  'sidebar-nav-test',
]

const SERVICE = [
  'qa-suite',
  'phase1-test', 'phase2-test', 'phase3-test', 'phase4-test', 'phase5-test',
  'phase6-test', 'phase7-test', 'phase8-test', 'phase9-test', 'phase11-test',
  'storage-stock-test', 'connection-url-test', 'action-transport-test',
  'staff-login-test', 'order-lifecycle-test', 'cogs-test',
  'negative-stock-test', 'reconciliation-test', 'production-ready-test',
  'stock-location-test',
  'branch-scope-test',
  'instructions-test',
  // redesignkitchenjob.md — prepared items: one-step Make Item, exact value
  // carried from raw stock into the prepared item, waste expensed separately,
  // idempotent completion, and production → recipe → sale → COGS exactly once.
  // Replaces production-flow-test and production-spec-test (recipe-driven jobs).
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
  'catalog-test',
  'purchasing-test',
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
  // production.md §14 — TOTP against the RFC vector, encrypted at rest,
  // single-use recovery codes.
  'mfa-test',
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
  // bugfix.md — the staff-codes page per branch, the pulse stream confined,
  // uploads checked by signature, cross-tenant writes through real actions.
  'security-runtime-test',
  // websiteconnect.md — the website API over real HTTP: key refused and accepted,
  // menu priced per branch, an order that lands ONLINE, a browser call refused.
  'website-api-test',
  // AUDIT.md C1/H10/H11 — a guest edit must hit kitchen, bill and stock alike.
  'guest-edit-test',
  'role-url-refusal-test', 'join-flow-test', 'cashier-gate-test',
  // Needs a served route: it asks the running app what its change-token says.
  'pulse-scope-test',
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
  // correctionA.md §1 — every type the UI offers is one the route answers, in
  // both formats, and report.export alone opens none of them: each still needs
  // the permission that guards the screen it comes from.
  'export-coverage-test',
  // sidebar.md §5/§8 — the rail, the drawer and the collapse measured in a real
  // browser at three widths. Both surfaces render the same component, so the
  // markup is identical at every size and only computed CSS can tell them apart.
  'sidebar-responsive-test',
]

interface Outcome {
  name: string
  kind: string
  passed: number
  failed: number
  skipped: boolean
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

  if (/skipping\./i.test(out)) return { name, kind, passed: 0, failed: 0, skipped: true }

  const tally = out.match(/(\d+) passed, (\d+) failed/)
  if (tally) {
    return { name, kind, passed: Number(tally[1]), failed: Number(tally[2]), skipped: false }
  }
  // A guard script reports by exit code and a single line.
  if (!crashed && /✓/.test(out)) return { name, kind, passed: 1, failed: 0, skipped: false }
  return { name, kind, passed: 0, failed: 1, skipped: false }
}

async function main() {
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
    }
  }

  const passed = results.reduce((n, r) => n + r.passed, 0)
  const failed = results.reduce((n, r) => n + r.failed, 0)
  const skipped = results.filter((r) => r.skipped)

  console.log(`\n${'═'.repeat(62)}`)
  console.log(`  ${passed} passed · ${failed} failed · ${skipped.length} suite(s) skipped`)

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
  console.log()
  process.exit(failed === 0 ? 0 : 1)
}

main()
