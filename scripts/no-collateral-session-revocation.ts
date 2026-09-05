/**
 * Only a credential event may sign people out (athu.md).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `setRestaurantFeaturesAction` used to revoke every session in a restaurant
 * whenever a platform admin changed a feature flag — "same shape
 * suspendRestaurant uses", said the comment, and it was: the same six lines,
 * copied into a place where they meant something entirely different. Suspending
 * a restaurant is SUPPOSED to stop people working. Selling it one more feature is
 * not, and the revocation was never needed for the change to apply — the
 * feature set is read live on every request. A whole restaurant was logged out
 * mid-service for nothing, and nothing in the build noticed.
 *
 * Writing `revokedAt` is how a session ends. It is a small, deliberate set of
 * places, all of them credential or deactivation events, and this guard names
 * them. A file that starts writing it has either joined that set for a real
 * reason — add it here with a sentence — or copied six lines it should not have.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/no-collateral-session-revocation.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src']

/**
 * Files permitted to end a session, and why each one is.
 *
 * Every entry is a credential or an account-state change — the cases where
 * "you are signed out" is the point, not a side effect.
 */
const ALLOWED: Record<string, string> = {
  'src/server/auth/session.ts':
    'owns sessions: logout, rotation, revoke-all',
  'src/features/auth/actions.ts':
    'password reset and password change end the sessions the old password opened',
  'src/features/staff/actions.ts':
    'deactivating a member of staff, reissuing their sign-in code, resetting their password',
  'src/features/platform/actions.ts':
    'suspending a restaurant is meant to stop its staff working',
  'src/features/platform/ops-actions.ts':
    'the platform operator deactivating an account or ending its sessions',
}

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
  let writes = 0

  for (const root of ROOTS) {
    for (const file of files(root)) {
      const raw = readFileSync(file, 'utf8')
      if (!raw.includes('revokedAt')) continue
      scanned += 1
      const src = stripComments(raw)

      /*
       * A WRITE is `revokedAt:` inside a `data:` block, or the SQL spelling.
       * Reading it in a `where:` clause — "only live sessions" — is how every
       * session lookup works and is not what this guard is about.
       */
      const writePattern = /data:\s*\{[^}]*\brevokedAt\s*:/g
      const sqlPattern = /UPDATE\s+"?sessions"?\s+SET[^;]*"?revokedAt"?\s*=/gi

      for (const pattern of [writePattern, sqlPattern]) {
        for (let m = pattern.exec(src); m; m = pattern.exec(src)) {
          writes += 1
          if (file in ALLOWED) continue
          const line = src.slice(0, m.index).split('\n').length
          offenders.push(`  ${file}:${line}`)
        }
      }
    }
  }

  console.log(`files scanned:      ${scanned}`)
  console.log(`revocation writes:  ${writes}`)
  console.log(`allowed files:      ${Object.keys(ALLOWED).length}`)

  if (offenders.length > 0) {
    console.error(`\n✖ ${offenders.length} file(s) end sessions without being a credential event:\n`)
    console.error(offenders.join('\n'))
    console.error(
      '\nWriting `revokedAt` signs somebody out. Do it only when that is the point —\n' +
        'a password changed, an account deactivated, a restaurant suspended.\n\n' +
        'If a setting has to "take effect", it almost certainly already does: role\n' +
        'permissions and the sold feature set are both read live on every request in\n' +
        'resolveUser. Revoking sessions to refresh them is the bug this guard was\n' +
        'written after, not the fix.\n\n' +
        'If this really is a new credential event, add the file to ALLOWED with a\n' +
        'sentence saying why.',
    )
    process.exit(1)
  }

  console.log('\n✓ every session revocation is a credential or deactivation event')
}

main()
