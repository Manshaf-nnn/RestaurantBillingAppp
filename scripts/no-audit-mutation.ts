/**
 * Application code may append to the audit trail. It may not rewrite it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `src/server/audit.ts` used to carry a function called `assertAuditImmutable`
 * that threw if anyone called it — and nothing ever did. Its own comment
 * explained that audit logs were append-only because "nothing in the codebase
 * calls `auditLog.update` or `auditLog.delete`". That is a description of the
 * source at one moment in time, dressed up as a guarantee. The next person to
 * write `prisma.auditLog.update(...)` would have met no resistance whatsoever,
 * and would have had every reason to believe the guard had their back.
 *
 * A log an ordinary user can edit is not an audit trail, it is a diary. The
 * same reasoning covers the money ledgers: a refund that can be edited after
 * the fact, or a payment whose amount can be revised once it has been taken,
 * removes the evidence that anything was ever different.
 *
 * ── The other half ──────────────────────────────────────────────────────────
 *
 * The real enforcement is in the database — migration
 * `20260917093000_append_only_guards` puts BEFORE UPDATE triggers on
 * `audit_logs`, `refunds`, `stock_movements` (ledger columns only) and
 * `payments` (settled amounts only). That holds against a script and a psql
 * session, not just against this codebase.
 *
 * This check exists so the failure arrives in CI with a file and a line number,
 * rather than at runtime as a Postgres exception in front of whoever pressed
 * the button.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/no-audit-mutation.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Application code only.
 *
 * `scripts/` is deliberately excluded: test suites delete their own fixture
 * restaurants and clean up the audit rows those fixtures produced, which is
 * legitimate and is why DELETE is not blocked at the database level either.
 */
const ROOTS = ['src']

/** model -> the operations that must never appear against it. */
const FROZEN: Record<string, string[]> = {
  auditLog: ['update', 'updateMany', 'upsert', 'delete', 'deleteMany'],
  refund: ['update', 'updateMany', 'upsert'],
}

/**
 * Places a mutation is legitimate.
 *
 * Only a platform-level retention job belongs here, and it should be reviewed
 * as carefully as the trigger it works around.
 */
const ALLOWED: Record<string, string> = {}

function files(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...files(full))
    else if (/\.tsx?$/.test(entry)) found.push(full)
  }
  return found
}

/** Strip comments, so the prose explaining the rule cannot trip the rule. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function main() {
  const offenders: string[] = []
  let scanned = 0
  let sites = 0

  for (const root of ROOTS) {
    for (const file of files(root)) {
      const raw = readFileSync(file, 'utf8')
      if (!/\b(auditLog|refund)\./.test(raw)) continue
      scanned += 1
      const src = stripComments(raw)

      for (const [model, operations] of Object.entries(FROZEN)) {
        for (const operation of operations) {
          // `prisma.auditLog.update(`, `tx.auditLog.update(`, `db.refund.upsert(`
          const pattern = new RegExp(`\\.${model}\\.${operation}\\s*\\(`, 'g')
          for (let m = pattern.exec(src); m; m = pattern.exec(src)) {
            sites += 1
            const line = src.slice(0, m.index).split('\n').length
            const key = `${file}:${line}`
            if (key in ALLOWED) continue
            offenders.push(`  ${file}:${line}  ${model}.${operation}()`)
          }
        }
      }
    }
  }

  console.log(`files scanned:   ${scanned}`)
  console.log(`mutation sites:  ${sites}`)
  console.log(`allowed:         ${Object.keys(ALLOWED).length}`)

  if (offenders.length > 0) {
    console.error(`\n✖ ${offenders.length} call(s) rewrite an append-only record:\n`)
    console.error(offenders.join('\n'))
    console.error(
      '\nThe audit trail and the refund ledger are append-only. The database\n' +
        'will refuse these writes (migration 20260917093000_append_only_guards),\n' +
        'so this would fail at runtime in front of a user.\n\n' +
        'Correct a record by writing another one — a reversal, a compensating\n' +
        'refund, a fresh audit row describing the correction — so the history\n' +
        'shows what happened AND what was done about it.',
    )
    process.exit(1)
  }

  console.log('\n✓ nothing in src rewrites an append-only record')
}

main()
