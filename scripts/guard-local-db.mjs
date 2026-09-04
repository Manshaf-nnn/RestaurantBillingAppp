/**
 * Refuse to run a schema-push command against anything but a local database.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `npm run setup` and `npm run setup:prod` call `prisma db push`. That command
 * writes the schema straight into the database without recording a migration,
 * and the state it leaves behind — tables present, `_prisma_migrations` empty
 * or incomplete — is precisely the state `scripts/deploy-db.mjs` had to be
 * written to detect and repair. Its own header comment names these two scripts
 * as the origin of that problem.
 *
 * `setup:prod` is the dangerous one, because the name invites exactly the
 * mistake: it reads as "set up production". Run against the live Neon database
 * it can drop columns to make the schema match, with no migration recorded and
 * nothing to roll back to.
 *
 * The real deploy path never uses push — Netlify and Render both run
 * `db:deploy:safe` (`prisma migrate deploy` with a baseline check). So nothing
 * legitimate is lost by refusing a remote host here.
 *
 *   node scripts/guard-local-db.mjs
 */
import { readFileSync } from 'node:fs'

/**
 * Read DATABASE_URL the way Prisma does.
 *
 * The real environment wins — that is what Netlify and Render inject — but
 * locally the value only exists in `.env`, which plain `node` does not load.
 * Without this the guard would fail every `npm run setup` on a developer's
 * machine, and a guard that blocks the legitimate case gets deleted.
 */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  for (const file of ['.env.local', '.env']) {
    try {
      const match = readFileSync(file, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)
      if (match) return match[1].trim().replace(/^["']|["']$/g, '')
    } catch {
      // No such file — try the next one.
    }
  }
  return undefined
}

const raw = databaseUrl()

if (!raw) {
  console.error('\n✖ DATABASE_URL is not set — refusing to push a schema into the unknown.\n')
  process.exit(1)
}

let host = ''
try {
  host = new URL(raw).hostname
} catch {
  console.error(`\n✖ DATABASE_URL is not a valid URL, so its host cannot be checked.\n`)
  process.exit(1)
}

const LOCAL = ['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'postgres', 'db']
const isLocal = LOCAL.includes(host) || host.endsWith('.local')

if (!isLocal) {
  console.error(
    `\n✖ Refusing to run "prisma db push" against ${host}.\n\n` +
      '  db push writes the schema with no migration recorded, and can drop\n' +
      '  columns to make the database match. Against a real database that is\n' +
      '  unrecoverable data loss with no migration history to roll back to.\n\n' +
      '  To change a remote schema, write a migration and deploy it:\n\n' +
      '      npx prisma migrate dev --name <what-changed>   # locally\n' +
      '      npm run db:deploy:safe                          # on the target\n\n' +
      '  If you genuinely mean to push to this host, run the prisma command\n' +
      '  directly and take responsibility for it — this guard is on the npm\n' +
      '  scripts, deliberately, because the danger is the habit not the tool.\n',
  )
  process.exit(1)
}

console.log(`✓ ${host} is local — schema push allowed`)
