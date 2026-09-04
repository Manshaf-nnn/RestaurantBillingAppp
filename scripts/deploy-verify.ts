/**
 * Did the deploy actually work? (production.md §15)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A green build is not a working site. The failures this catches are all ones a
 * build cannot see: the database is behind the code because a migration did not
 * run, the app boots but cannot reach Postgres, a page renders an error, the
 * commit serving traffic is not the commit that was pushed.
 *
 * Run it against a deploy — staging before promotion, production after — and it
 * exits non-zero if the site is not actually serving. That exit code is what
 * makes it usable in a pipeline; the output is what makes it usable at 2am.
 *
 *   BASE_URL=https://staging.example.com npx tsx --tsconfig tsconfig.test.json scripts/deploy-verify.ts
 *   BASE_URL=... EXPECT_COMMIT=$COMMIT_REF npx tsx ... scripts/deploy-verify.ts
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const EXPECT_COMMIT = process.env.EXPECT_COMMIT

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function get(path: string, timeoutMs = 15_000) {
  const started = Date.now()
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json,text/html' },
    })
    const text = await response.text()
    return { status: response.status, text, ms: Date.now() - started, ok: true as const }
  } catch (error) {
    return {
      status: 0,
      text: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
      ok: false as const,
    }
  }
}

async function main() {
  console.log(`\n── Verifying ${BASE_URL} ──`)

  // 1. Is anything there, and does it hold a database connection?
  const health = await get('/api/health')
  check('the health endpoint answers', health.ok && health.status < 500,
    `${health.status} ${health.text.slice(0, 200)}`)

  let build: { commit?: string | null } = {}
  if (health.ok) {
    try {
      const body = JSON.parse(health.text) as {
        status?: string
        checks?: Record<string, string>
        build?: { commit?: string | null }
      }
      build = body.build ?? {}
      check('it reports healthy, not degraded', body.status === 'healthy', body.status ?? '?')
      check('the database is reachable from the running app',
        body.checks?.database === 'ok', body.checks?.database ?? '?')
    } catch {
      check('the health endpoint returns JSON', false, health.text.slice(0, 120))
    }
  }

  /*
   * 2. The commit actually serving traffic.
   *
   * "Did my fix reach the site" is the question that wastes the most time
   * during an incident, and a deploy that silently served the previous build is
   * indistinguishable from a fix that did not work.
   */
  if (EXPECT_COMMIT) {
    check('the deployed commit is the one that was pushed',
      Boolean(build.commit) && EXPECT_COMMIT.startsWith(build.commit!.slice(0, 7)),
      `serving ${build.commit ?? 'unknown'}, expected ${EXPECT_COMMIT.slice(0, 7)}`)
  } else {
    console.log('  · commit not checked — set EXPECT_COMMIT to pin it')
  }

  /*
   * 3. Schema drift: the commonest cause of a healthy build serving broken
   * pages is a database missing columns the generated client expects. The
   * endpoint is owner-gated, so a 401/403 means the app is up and refusing
   * properly, which is itself a pass for this check.
   */
  const drift = await get('/api/health/db')
  check('the schema-drift check is reachable and not reporting drift',
    drift.ok && drift.status !== 500,
    drift.status === 500 ? drift.text.slice(0, 300) : `${drift.status}`)

  // 4. A real page renders. The login page is public and needs the app, React
  // and the CSS bundle, so a 200 here rules out most whole-app failures.
  const login = await get('/login')
  check('a public page renders', login.ok && login.status === 200, `${login.status}`)
  check('…and it looks like the application, not an error page',
    login.text.includes('TableFlow') || login.text.toLowerCase().includes('sign in'),
    login.text.slice(0, 120))

  // 5. The guest ordering surface, which is the one a customer sees first.
  const menu = await get('/api/public/whoami')
  check('the public tenant resolver answers', menu.ok && menu.status < 500, `${menu.status}`)

  // 6. Speed, as a smoke signal rather than a benchmark. A cold serverless
  // health check over the internet is not a p99, but ten seconds means something
  // is wrong that the status codes above did not show.
  check('the site responds within 10s cold', health.ms < 10_000, `${health.ms}ms`)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(
      '\n  This deploy is not serving correctly. See DISASTER-RECOVERY.md →\n' +
        '  "A deployment fails" for how to roll back.',
    )
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
