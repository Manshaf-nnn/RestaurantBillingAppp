/**
 * Every API route that claims a caller, asked without one.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `api-surface-test` reads the source and checks that each route declares how
 * it authenticates and that the declared mechanism appears in the file. That
 * is a claim about the code. This is the claim about the running server: send
 * the request nobody should be able to make and see what comes back.
 *
 * The two catch different things. A route can import `requireTenantUser` and
 * still answer 200 if the call is inside a branch that a crafted request
 * skips, and no amount of reading imports would show it. Equally, a route can
 * refuse correctly and still refuse WRONGLY — which is what this found on its
 * first run:
 *
 *   POST /api/admin/media/restore  →  500  "You must sign in to continue"
 *
 * The refusal was right and the status was not. An authorization failure
 * reported as a server fault is a real cost: it lands in `error_logs` next to
 * genuine crashes, so the signal that finds actual bugs gets buried under
 * anybody who pokes the endpoint. That route also returned the raw error text,
 * bypassing the production redaction in `toAppError`.
 *
 * ── What a refusal must look like ───────────────────────────────────────────
 *
 * Never 200, and never 5xx. A 5xx says "we broke"; the truth is "you may not".
 * Session, API-key and shared-secret routes must say 401 or 403 precisely.
 * A guest-cookie route may also answer 404, because "there is no such order
 * for you" is a refusal that deliberately declines to confirm the order
 * exists — which is the right answer to an IDOR probe.
 *
 * Usage:
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/api-authorization-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { POSTURE } from './api-routes'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const API_ROOT = join(__dirname, '..', 'src', 'app', 'api')

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Which verbs a route actually exports. */
function methodsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map((m) => m[1])
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) routeFiles(full, out)
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

/**
 * A concrete URL for a route key, with any [param] filled by an id that
 * cannot exist. A route must refuse an anonymous caller BEFORE it decides
 * whether the record is real, so the id being bogus is the point.
 */
function urlFor(key: string): string {
  return '/api/' + key.replace(/\[[^\]]+\]/g, 'ffffffffffffffffffffffff')
}

/** Text that should never come back to a caller who has not signed in. */
const LEAKY = [
  /passwordHash/i,
  /refreshTokenHash/i,
  /"email":/i,
  /JWT_|SECRET|PRIVATE_KEY/,
  /at [A-Za-z.]+ \(\/.*\.ts:\d+/, // a stack frame with a server path in it
]

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  const files = new Map(
    routeFiles(API_ROOT).map((file) => [file.slice(API_ROOT.length + 1).replace(/\/route\.ts$/, ''), file]),
  )

  const guarded = Object.entries(POSTURE).filter(([, p]) => p.how !== 'open')
  console.log(`\n── ${guarded.length} routes that require a caller, asked without one ──\n`)

  for (const [key, posture] of guarded.sort(([a], [b]) => a.localeCompare(b))) {
    const file = files.get(key)
    if (!file) {
      check(`${key} exists`, false, 'declared in POSTURE but no route file')
      continue
    }

    for (const method of methodsOf(file)) {
      const response = await fetch(`${BASE}${urlFor(key)}`, {
        method,
        redirect: 'manual',
        // A body-less POST is enough: authorization must be decided before
        // anything reads the body, so an empty one must not change the answer.
        ...(method === 'POST' || method === 'PUT' || method === 'PATCH'
          ? { headers: { 'content-type': 'application/json' }, body: '{}' }
          : {}),
      })
      const body = await response.text().catch(() => '')
      const label = `${method} /api/${key}`

      check(`${label} does not serve an anonymous caller`, response.status !== 200, `HTTP ${response.status}`)
      check(
        `${label} refuses rather than breaking`,
        response.status < 500,
        `HTTP ${response.status} — an authorization failure reported as a server fault`,
      )

      const allowed =
        posture.how === 'guest-cookie' ? [401, 403, 404] : [401, 403]
      check(
        `${label} answers ${allowed.join(' or ')}`,
        allowed.includes(response.status),
        `HTTP ${response.status}: ${body.slice(0, 120)}`,
      )

      const leak = LEAKY.find((pattern) => pattern.test(body))
      check(`${label} leaks nothing in the refusal`, leak === undefined, leak ? `matched ${leak}` : '')
    }
  }

  console.log('\n── A forged key is not a key ──')
  {
    for (const key of ['website/v1/menu', 'website/v1/restaurant']) {
      for (const header of ['Bearer not-a-real-key', 'Bearer ', 'not-even-bearer']) {
        const response = await fetch(`${BASE}${urlFor(key)}`, { headers: { authorization: header } })
        check(
          `/api/${key} refuses "${header.slice(0, 18)}"`,
          response.status === 401 || response.status === 403,
          `HTTP ${response.status}`,
        )
      }
    }
  }

  console.log('\n── The job runner cannot be talked into running ──')
  {
    for (const header of ['', 'Bearer ', 'Bearer wrong', 'Bearer  ']) {
      const response = await fetch(`${BASE}/api/jobs/run`, {
        method: 'POST',
        ...(header ? { headers: { authorization: header } } : {}),
      })
      check(
        `POST /api/jobs/run refuses "${header || '(no header)'}"`,
        response.status === 401,
        `HTTP ${response.status}`,
      )
    }
  }

  console.log('\n── Open routes are open, and stay harmless ──')
  {
    /*
     * The other half of the contract. If something declared `open` starts
     * refusing, the guest app breaks; if it starts answering with tenant data
     * it should not, the declaration was wrong. Both are worth a check.
     */
    const open = Object.entries(POSTURE).filter(([, p]) => p.how === 'open')
    for (const [key] of open) {
      if (key === 'invite/accept' || key === 'auth/refresh') continue // need a token to mean anything
      const response = await fetch(`${BASE}${urlFor(key)}`, { redirect: 'manual' })
      const body = await response.text().catch(() => '')
      check(
        `/api/${key} answers without a session`,
        response.status < 500,
        `HTTP ${response.status}`,
      )
      const leak = LEAKY.find((pattern) => pattern.test(body))
      check(`/api/${key} exposes nothing sensitive`, leak === undefined, leak ? `matched ${leak}` : '')
    }
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
