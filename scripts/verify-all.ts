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
  'no-bad-server-exports', 'no-function-props', 'no-raw-action-calls',
  'no-unscoped-branch-pages', 'no-unguarded-feature-pages',
  'no-item-branch-filter',
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
  'production-spec-test',
  'catalog-test',
  'purchasing-test',
  'supplier-ledger-test',
  'search-test',
  'locations-test',
  'branch-isolation-test',
  'dashboard-period-test',
  'role-permissions-test',
  'access-links-test',
  'pos-billing-test',
  // AUDIT.md Slice 2 — tips, refund rows, discount split, counters, loyalty ledger.
  'payment-model-test',
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
  // acCal.md §9 — the derived journal balances and ties to every engine.
  'ledger-test',
  // acCal.md §6 — statement import, matching rules, duplicates, races.
  'bank-rec-test',
  // acCal.md §13 — the month-end checklist answers from the records.
  'month-close-test',
  // acCal.md §12 — the price simulator's maths, and that it writes nothing.
  'what-if-test',
  // AUDIT.md Slice 7 — the §101 worked example, end to end, and the billing
  // engine's own matrix.
  'e2e-reconciliation-test',
  'variant-order-test',
  'custom-domain-test',
  'cash-drawer-test',
  'role-assignment-test',
  'branch-isolation-2-test',
  'stock-count-branch-test',
  'expiry-tracking-test',
  'staff-attendance-test',
  'live-board-test',
  'recipe-costing-test',
  'input-stability-test',
  'kitchen-routing-test',
  'menu-station-test',
  'cash-drawer-flow-test',
  'feature-access-test',
]

const RUNTIME = [
  'page-render-test', 'action-e2e-test', 'qr-to-kitchen-test',
  // AUDIT.md C1/H10/H11 — a guest edit must hit kitchen, bill and stock alike.
  'guest-edit-test',
  'role-url-refusal-test', 'join-flow-test', 'cashier-gate-test',
  // Needs a served route: it asks the running app what its change-token says.
  'pulse-scope-test',
  // Skips itself unless the server carries Socket.IO (`node server.mjs`).
  'socket-order-room-test',
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
