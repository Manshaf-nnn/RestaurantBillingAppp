/**
 * The one command to run before a release.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * `verify-all` answers "did anything fail". That is not the same question as
 * "is this safe to ship", and the difference is the one this codebase has
 * already been caught by twice:
 *
 *   · a `next start` died mid-run, twenty-two suites turned into skips, and
 *     the summary read "5040 passed · 1 failed" — greener than a red run;
 *   · three suites had never executed at all for months, because their
 *     dependencies were missing and a missing dependency reads as a skip.
 *
 * Both times the number looked fine. So this gate does not ask what the
 * number is. It asks, for each thing that MUST be covered before a release,
 * whether the suite that covers it actually ran and actually passed — and it
 * refuses if the answer is "we do not know".
 *
 * ── What it checks ──────────────────────────────────────────────────────────
 *
 *   1. Every dependency is present. Not "skipped for a good reason" — a
 *      release cannot be signed off on coverage nobody ran.
 *   2. TypeScript compiles, and the build succeeds.
 *   3. `verify-all` passes, with zero skips of either kind.
 *   4. Each mandatory area below has a named suite that ran and passed.
 *
 * Any of those failing exits non-zero.
 *
 * Usage:
 *   npx next build
 *   node server.mjs &                       # server.mjs, not `next start`:
 *                                           # the socket suite needs Socket.IO
 *   npx playwright install chromium         # once
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/release-gate.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const BASE_URL = process.env.BASE_URL
const REPORT = join(process.cwd(), '.release-gate-report.json')

/**
 * Each area a release must not ship without, and the suite that covers it.
 *
 * Named areas rather than a bare suite list, because the point is to state
 * what is being promised. If a suite is renamed or removed, this fails and
 * somebody has to say which suite covers that promise now — which is the
 * conversation worth forcing.
 */
const MANDATORY: Array<{ area: string; suites: string[] }> = [
  { area: 'Financial arithmetic', suites: ['billing-math-test', 'no-hand-rolled-money'] },
  { area: 'Split payments and refunds', suites: ['payment-model-test', 'concurrency-test'] },
  { area: 'FIFO costing', suites: ['fifo-engine-test', 'fifo-invariants-test', 'no-average-cost-valuation'] },
  { area: 'COGS and profit', suites: ['cogs-test'] },
  { area: 'RBAC', suites: ['role-permissions-test', 'no-unguarded-feature-pages'] },
  { area: 'Tenant isolation', suites: ['tenant-isolation-test', 'branch-isolation-test'] },
  { area: 'API authorization', suites: ['api-surface-test', 'api-authorization-test'] },
  { area: 'Tenant purge', suites: ['tenant-purge-test'] },
  { area: 'Concurrency', suites: ['concurrency-test', 'phase11-test'] },
  { area: 'Database integrity', suites: ['migration-safety-test', 'no-audit-mutation'] },
  { area: 'Page render', suites: ['page-render-test'] },
  { area: 'Browser console', suites: ['browser-console-test'] },
  { area: 'Report filters', suites: ['report-filter-test'] },
  { area: 'Realtime', suites: ['socket-order-room-test'] },
  { area: 'Responsive UI', suites: ['sidebar-responsive-test'] },
  { area: 'Test data isolation', suites: ['no-unscoped-fixtures'] },
]

let failed = 0

function step(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

function run(label: string, command: string, args: string[], env: Record<string, string> = {}): boolean {
  try {
    execFileSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    step(label, true)
    return true
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    const output = ((e.stdout ?? '') + (e.stderr ?? '')).trim().split('\n').slice(-8).join('\n      ')
    step(label, false, `\n      ${output}`)
    return false
  }
}

async function main() {
  console.log('\n══ release gate ══════════════════════════════════════════════\n')

  if (!BASE_URL) {
    console.log('  ✗ BASE_URL is not set.')
    console.log('\n    A release cannot be signed off without the runtime tier, and the')
    console.log('    runtime tier needs a server. Build, start server.mjs, and set BASE_URL.\n')
    process.exit(1)
  }

  console.log('── 1. It compiles and builds ──')
  run('typescript', 'npm', ['run', 'typecheck'])
  run('lint', 'npm', ['run', 'lint'])
  step(
    'a build exists',
    existsSync('.next/BUILD_ID'),
    existsSync('.next/BUILD_ID') ? readFileSync('.next/BUILD_ID', 'utf8').trim() : 'run npx next build',
  )

  console.log('\n── 2. Everything ran ──')
  if (existsSync(REPORT)) unlinkSync(REPORT)
  const verified = run(
    'verify-all',
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/verify-all.ts'],
    { VERIFY_REPORT: REPORT },
  )

  if (!existsSync(REPORT)) {
    step('the gate produced a report', false, 'verify-all wrote no report — it may have exited before finishing')
    console.log('\n  Cannot judge a release on a run that did not complete.\n')
    process.exit(1)
  }

  const report = JSON.parse(readFileSync(REPORT, 'utf8')) as {
    passed: number
    failed: number
    available: string[]
    expectedSkips: string[]
    unexpectedSkips: string[]
    serverDiedMidRun: boolean
    suites: Array<{ name: string; passed: number; failed: number; skipped: boolean }>
  }

  step('verify-all passed', verified && report.failed === 0, `${report.passed} passed, ${report.failed} failed`)
  step('the server survived the run', !report.serverDiedMidRun)
  step('no unexpected skips', report.unexpectedSkips.length === 0, report.unexpectedSkips.join(', '))
  /*
   * An EXPECTED skip is fine during development and is not fine here. It
   * means a dependency was missing, which means a real area of the product
   * was not exercised — and the whole purpose of this gate is that shipping
   * on unexercised coverage is the mistake it exists to prevent.
   */
  step(
    'no expected skips either — a release covers everything',
    report.expectedSkips.length === 0,
    report.expectedSkips.length ? `${report.expectedSkips.join(', ')} (start what they need)` : '',
  )
  for (const dependency of ['postgres', 'server', 'socket', 'browser']) {
    step(`${dependency} was available`, report.available.includes(dependency))
  }

  console.log('\n── 3. Each promise has a suite that kept it ──')
  const byName = new Map(report.suites.map((suite) => [suite.name, suite]))
  for (const { area, suites } of MANDATORY) {
    const missing: string[] = []
    for (const name of suites) {
      const suite = byName.get(name)
      if (!suite) missing.push(`${name} is not in the run`)
      else if (suite.skipped) missing.push(`${name} skipped`)
      else if (suite.failed > 0) missing.push(`${name} failed`)
      else if (suite.passed === 0) missing.push(`${name} asserted nothing`)
    }
    step(area, missing.length === 0, missing.join('; '))
  }

  console.log(`\n${'═'.repeat(62)}`)
  if (failed > 0) {
    console.log(`  ✖ NOT READY TO RELEASE — ${failed} check(s) did not pass.\n`)
    process.exit(1)
  }
  console.log(`  ✓ READY — ${report.passed} checks, nothing skipped, every area covered.\n`)
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
