/**
 * Guards the connection string built for Neon.
 *
 * This exists because a change that only applied to neon.tech hosts took
 * production down while every local test passed — localhost skips that branch
 * entirely. Any parameter added there must be proven safe here.
 */
import { buildConnectionUrl } from '../src/server/db/prisma'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, d = '') => c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`))

// Anything not on this list has never been proven to work through PgBouncer.
const SAFE = new Set([
  'sslmode', 'connection_limit', 'pool_timeout', 'connect_timeout',
  'pgbouncer', 'channel_binding', 'application_name', 'schema',
])

const POOLED = 'postgresql://u:p@ep-x-pooler.c-2.us-east-1.aws.neon.tech/db?sslmode=require'
const DIRECT = 'postgresql://u:p@ep-x.c-2.us-east-1.aws.neon.tech/db?sslmode=require'
const LOCAL = 'postgresql://u:p@localhost:5432/db'

const params = (url: string) => [...new URL(url).searchParams.keys()]

const pooled = buildConnectionUrl(POOLED)!
const direct = buildConnectionUrl(DIRECT)!

console.log('\n── Connection string safety ─────────────────────────────')
const unsafe = params(pooled).filter((k) => !SAFE.has(k))
ok('pooled URL carries only proven parameters', unsafe.length === 0, `unexpected: ${unsafe.join(', ')}`)
ok('no libpq `options` startup parameter', !params(pooled).includes('options'))
ok('pgbouncer mode is declared', new URL(pooled).searchParams.get('pgbouncer') === 'true')
ok('pooled gets a workable connection limit',
  Number(new URL(pooled).searchParams.get('connection_limit')) >= 10)
ok('timeouts stay under the 10s function budget',
  Number(new URL(pooled).searchParams.get('connect_timeout')) < 10 &&
  Number(new URL(pooled).searchParams.get('pool_timeout')) < 10)
ok('direct URL is not marked as pgbouncer', !params(direct).includes('pgbouncer'))
ok('a local URL is returned untouched', buildConnectionUrl(LOCAL) === LOCAL)
ok('a malformed URL is passed through rather than throwing', buildConnectionUrl('not-a-url') === 'not-a-url')
ok('an absent URL stays undefined', buildConnectionUrl(undefined) === undefined)

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
process.exit(fail === 0 ? 0 : 1)
