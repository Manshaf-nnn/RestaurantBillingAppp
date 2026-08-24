/**
 * Bring the production database up to date, whatever state it is in.
 *
 * ── The bug this replaces ───────────────────────────────────────────────────
 *
 * The deploy ran `prisma migrate deploy` directly. That command refuses, with
 * `Error: P3005 — The database schema is not empty`, on any database that has
 * tables but no `_prisma_migrations` history.
 *
 * Which is exactly the database this project creates. `render.yaml` deploys
 * with `npx prisma db push`, and `npm run setup:prod` does the same — and
 * `db push` builds the schema WITHOUT recording any migration history. So the
 * moment the build chain moved to `migrate deploy`, every deploy began failing
 * at the second command, before `next build` ever ran.
 *
 * The failure is silent from the outside. The push succeeds, the commit is on
 * GitHub, the host reports a failed build somewhere in a log nobody opens, and
 * the live site keeps serving the last version that worked. A fix can be
 * written, reviewed, merged and never reach a single user.
 *
 * ── What this does instead ──────────────────────────────────────────────────
 *
 * Three states, handled explicitly:
 *
 *   1. Empty database          → apply every migration. A fresh install.
 *   2. Has migration history   → apply whatever is new. The ordinary case.
 *   3. Tables but no history   → BASELINE it, then apply what is new.
 *
 * Case 3 is the one that was breaking. Baselining means telling Prisma "these
 * migrations are already in this database" — which is true, because `db push`
 * applied their effects. It is done by marking each as applied and then
 * running the normal deploy, so any genuinely new migration still runs.
 *
 * ── The safety check ────────────────────────────────────────────────────────
 *
 * Marking a migration as applied when it is NOT would skip a real schema
 * change for ever, and the symptom would be a missing column at runtime rather
 * than an error at deploy. So baselining only happens when the database
 * already matches the schema — verified with `migrate diff` before anything is
 * written. If it does not match, this stops and prints the difference rather
 * than guessing.
 *
 * Run manually:  node scripts/deploy-db.mjs
 *
 * Plain JavaScript on purpose. `tsx` is a devDependency, and a host that sets
 * NODE_ENV=production skips devDependencies — so a TypeScript deploy script
 * would fail on the one machine it has to work on. It needs `node` and the
 * Prisma client, both of which are always present.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import pkg from '@prisma/client'
const { PrismaClient } = pkg

const prisma = new PrismaClient()

function run(args) {
  try {
    const out = execFileSync('npx', ['prisma', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    return { ok: true, out }
  } catch (error) {
    const e = error
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** Migration folder names, in the order Prisma applies them. */
function migrationNames() {
  return readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function tableCount() {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::bigint AS n
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  return Number(rows[0]?.n ?? 0)
}

async function hasMigrationHistory() {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::bigint AS n
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`
  if (Number(rows[0]?.n ?? 0) === 0) return false
  const applied = await prisma.$queryRaw`
    SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations"`
  return Number(applied[0]?.n ?? 0) > 0
}

/**
 * Does the live database already match the schema?
 *
 * `migrate diff` prints the SQL that would take the database to the schema.
 * Nothing to do means they agree, and baselining is safe.
 */
function schemaMatchesDatabase() {
  const result = run([
    'migrate',
    'diff',
    '--from-url',
    process.env.DIRECT_URL || process.env.DATABASE_URL || '',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--script',
  ])
  const sql = result.out
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('--'))
    .join('\n')
    .trim()
  return { matches: sql.length === 0, diff: sql }
}

async function main() {
  console.log('── database ──────────────────────────────────────────────')

  const [tables, history] = await Promise.all([tableCount(), hasMigrationHistory()])
  console.log(`tables: ${tables} · migration history: ${history ? 'yes' : 'no'}`)

  // ── 1 & 2: the ordinary paths ───────────────────────────────────────────
  if (tables === 0 || history) {
    const label = tables === 0 ? 'fresh database' : 'applying new migrations'
    console.log(`${label} → prisma migrate deploy`)
    const result = run(['migrate', 'deploy'])
    console.log(result.out.trim())
    if (!result.ok) {
      console.error('\n✖ migrations failed — the deploy is stopping here on purpose.')
      console.error('  Shipping code against a database that did not get its schema')
      console.error('  change is how a column goes missing at runtime.')
      process.exit(1)
    }
    console.log('\n✓ database is up to date')
    return
  }

  // ── 3: tables, but nobody recorded how they got there ───────────────────
  console.log('\nThis database has tables but no migration history.')
  console.log('That is what `prisma db push` leaves behind — see the header of')
  console.log('this file. Checking whether it already matches the schema…')

  const { matches, diff } = schemaMatchesDatabase()

  if (!matches) {
    console.error('\n✖ The database does NOT match the schema, so it cannot be')
    console.error('  baselined safely — marking migrations as applied would skip')
    console.error('  these changes for ever:\n')
    console.error(diff.split('\n').slice(0, 40).join('\n'))
    console.error('\n  Fix it by bringing the database to the current schema once')
    console.error('  (`npx prisma db push`), then deploy again — this script will')
    console.error('  baseline it and every future deploy uses migrations properly.')
    process.exit(1)
  }

  console.log('It matches. Baselining…')
  const names = migrationNames()
  for (const name of names) {
    const result = run(['migrate', 'resolve', '--applied', name])
    // Already-resolved is success, not failure — this has to be safe to re-run.
    if (!result.ok && !/already recorded as applied/i.test(result.out)) {
      console.error(`\n✖ could not baseline ${name}:\n${result.out}`)
      process.exit(1)
    }
  }
  console.log(`marked ${names.length} migration(s) as already applied`)

  const after = run(['migrate', 'deploy'])
  console.log(after.out.trim())
  if (!after.ok) {
    console.error('\n✖ migrations failed after baselining')
    process.exit(1)
  }

  console.log('\n✓ database baselined and up to date')
  console.log('  Future deploys take the ordinary path.')
}

main()
  .catch((error) => {
    console.error('\n✖ could not reach the database:', error instanceof Error ? error.message : error)
    console.error('  Check DATABASE_URL in the host’s environment variables.')
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
