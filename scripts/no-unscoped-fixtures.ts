/**
 * A test fixture must say which tenant it means.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `live-board-test` did this:
 *
 *     prisma.customer.findFirstOrThrow({ where: { phone: '0772222222' } })
 *
 * and passed for months. Then another suite created a fixture customer with
 * the same hard-coded phone number, and this one started matching the OTHER
 * tenant's row. Two assertions failed on a customer that was entirely
 * correct, and the failure looked like a bug in the live board.
 *
 * The product is linted against exactly this mistake — `no-unscoped-branch-pages`
 * exists because an unscoped query is how one tenant's data reaches another —
 * and the test suite, which creates the most data and shares one database
 * between every suite, had no such rule. The consequence in a test is milder
 * than in production but it is the same defect, and it is worse in one way:
 * it makes a green suite depend on what other suites happen to have left
 * behind, which is how a suite becomes flaky without anyone changing it.
 *
 * ── What it looks for ───────────────────────────────────────────────────────
 *
 * A read or write on a tenant-scoped model, narrowed by a field people share
 * — a phone number, a name, a code — where the value is a plain literal and
 * nothing names a tenant. Three things keep it quiet, all of them the right
 * answer rather than an escape hatch:
 *
 *   restaurantId or branchId in the same `where`   → it says which tenant
 *   a value carrying `${…}`                        → stamped, so unique to this run
 *   a Restaurant lookup by slug                    → the slug IS the tenant
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/no-unscoped-fixtures.ts
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPTS = __dirname

/** Fields that identify a person or a thing to a HUMAN, not to the database. */
const SHARED_FIELDS = [
  'phone',
  'email',
  'name',
  'code',
  'number',
  'orderNumber',
  'batchNo',
  'staffCode',
  'slug',
  'sku',
  'barcode',
]

/**
 * Models where such a lookup is safe because the value is globally unique by
 * definition, each with the reason.
 */
const GLOBAL_MODELS: Record<string, string> = {
  restaurant: 'a restaurant IS the tenant, and its slug is unique across the platform',
  user: 'email is unique across the platform, so it can only ever match one person',
}

const READS = ['findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'count', 'deleteMany', 'updateMany']

let offences = 0
let checked = 0

/** The `where: { … }` object immediately after a call, balanced. */
function whereBlock(source: string, from: number): string | null {
  const at = source.indexOf('where:', from)
  if (at === -1 || at > from + 200) return null
  const open = source.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < source.length && i < open + 2000; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

for (const file of readdirSync(SCRIPTS).filter((name) => name.endsWith('-test.ts'))) {
  const source = readFileSync(join(SCRIPTS, file), 'utf8')
  checked += 1

  const call = new RegExp(`\\b(?:prisma|tx)\\.(\\w+)\\.(${READS.join('|')})\\s*\\(`, 'g')
  for (const match of source.matchAll(call)) {
    const model = match[1]
    const where = whereBlock(source, match.index ?? 0)
    if (!where) continue
    /*
     * Any foreign key counts as scoping.
     *
     * `orderItem.findFirst({ where: { orderId: bill.id, name: 'Curry' } })`
     * is narrowed to one order this run created, so the shared name cannot
     * reach another tenant. Five of the six things this rule first reported
     * were that shape, and treating them as offences would have taught
     * everyone to ignore it.
     */
    if (/\b\w*[Ii]d\s*:/.test(where)) continue
    if (GLOBAL_MODELS[model]) continue

    for (const field of SHARED_FIELDS) {
      // `field: '<literal>'` or `field: { … '<literal>' }`, with no `${`.
      const literal = new RegExp(`\\b${field}\\s*:\\s*(\\{[^{}]*\\}|'[^']*'|"[^"]*")`).exec(where)
      if (!literal) continue
      if (literal[1].includes('${')) continue // stamped — unique to this run

      const line = source.slice(0, match.index).split('\n').length
      offences += 1
      console.log(`\n  ${file}:${line} — ${model}.${match[2]} narrowed by ${field}, with no tenant`)
      console.log(`      ${literal[0].trim()}`)
      break
    }
  }
}

console.log(`\nchecked:  ${checked} suites`)
console.log(`exempt:   ${Object.keys(GLOBAL_MODELS).length} model(s), each with a stated reason in this file`)

if (offences > 0) {
  console.log(`\n✖ ${offences} unscoped fixture lookup(s):`)
  console.log(`
Every suite shares one database. A fixture found by a bare phone number, name
or code will one day match a row another suite left behind, and the assertion
that fails will be about the wrong record entirely.

Add restaurantId (or branchId) to the where, or put this run's stamp in the
value so it is unique to this run.
`)
  process.exitCode = 1
} else {
  console.log('\n✓ every fixture lookup says which tenant it means')
}
