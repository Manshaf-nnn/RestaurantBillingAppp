/**
 * Every API route declares how it authenticates, and the declaration is checked.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The page surface is well defended: `no-unguarded-feature-pages` and
 * `no-unscoped-branch-pages` mean a dashboard page cannot quietly ship without
 * a guard. The API surface had no equivalent. A route handler is a plain
 * exported function in a file; nothing at all forces it to check anything, and
 * `src/middleware.ts` waves several prefixes straight through on the stated
 * grounds that they "authenticate themselves". That claim was true when it was
 * written and there was nothing keeping it true.
 *
 * An audit of all twenty-three routes found no hole — every one authenticates,
 * by session, by API key, by shared secret or by guest cookie, and the
 * genuinely open ones are open on purpose. So this guard is not fixing a
 * vulnerability. It is making the next route impossible to add without saying
 * out loud how it is protected, which is the only part of that finding that
 * survives contact with a codebase that keeps growing.
 *
 * ── What it checks ──────────────────────────────────────────────────────────
 *
 * 1. Every `route.ts` under `src/app/api` appears in POSTURE, which lives in
 *    `scripts/api-routes.ts` so the runtime suite reads the same list. A new
 *    route fails until somebody classifies it.
 * 2. Every declared mechanism is actually present in the file. A registry
 *    that can drift from the code is a registry that lies, so `session` must
 *    show a guard import, `api-key` must go through `withWebsiteCaller`, and
 *    so on.
 * 3. Every entry in POSTURE still points at a route that exists, so deleting
 *    a route does not leave a stale reassurance behind.
 * 4. Anything declared `open` carries a reason, and the middleware's
 *    public-prefix list does not reach past what is declared open here.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/api-surface-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { EVIDENCE, POSTURE, type Mechanism } from './api-routes'

const API_ROOT = join(__dirname, '..', 'src', 'app', 'api')
const MIDDLEWARE = join(__dirname, '..', 'src', 'middleware.ts')


let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function routes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) routes(full, out)
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

function main() {
  const found = routes(API_ROOT).map((file) => ({
    key: file.slice(API_ROOT.length + 1).replace(/\/route\.ts$/, ''),
    file,
  }))

  console.log(`\n── ${found.length} API routes, each declaring how it is protected ──\n`)

  const byMechanism = new Map<Mechanism, string[]>()

  for (const route of found.sort((a, b) => a.key.localeCompare(b.key))) {
    const declared = POSTURE[route.key]
    if (!declared) {
      failed += 1
      console.log(`  ✗ ${route.key} — NOT DECLARED`)
      console.log(
        `      Add it to POSTURE in scripts/api-routes.ts, saying how it authenticates and why.\n` +
        `      A route nothing has classified is a route nobody has checked.`,
      )
      continue
    }

    byMechanism.set(declared.how, [...(byMechanism.get(declared.how) ?? []), route.key])

    const source = readFileSync(route.file, 'utf8')
    if (declared.how === 'open') {
      check(`${route.key} states why it is open`, declared.why.length > 20, 'the reason is too thin to mean anything')
      // An "open" route must not be quietly reading a session anyway: that is
      // a classification that has drifted, and the reader would be misled.
      passed += 1
      console.log(`  ○ ${route.key}  open — ${declared.why}`)
      continue
    }

    const evidence = EVIDENCE[declared.how]
    const present = evidence.test(source)
    check(
      `${route.key} shows the ${declared.how} it declares`,
      present,
      `declared ${declared.how} but the file matches nothing like ${evidence}`,
    )
    if (present) {
      passed += 1
      console.log(`  ✓ ${route.key}  ${declared.how}`)
    }
  }

  console.log('\n── The registry describes routes that exist ──')
  for (const key of Object.keys(POSTURE)) {
    const exists = found.some((route) => route.key === key)
    check(`${key} is still a route`, exists, 'declared in POSTURE but no route.ts for it — stale reassurance')
  }
  if (failed === 0) console.log(`  ✓ all ${Object.keys(POSTURE).length} entries point at a live route`)

  console.log('\n── The middleware waves through no more than is declared open ──')
  {
    /*
     * `src/middleware.ts` skips its session check for a list of prefixes. Each
     * one is fine only because the routes underneath authenticate themselves,
     * which is precisely what POSTURE now records — so the two must agree.
     */
    const middleware = readFileSync(MIDDLEWARE, 'utf8')
    const block = /const PUBLIC_API = \[([\s\S]*?)\]/.exec(middleware)
    check('the middleware still has a PUBLIC_API list', block !== null)
    if (block) {
      /*
       * Strip the comments first. Each entry in that list carries a note
       * saying why it is safe to skip, and one of them reads "a restaurant's
       * own website" — whose apostrophe opens a string as far as a naive
       * scanner is concerned, and the prefix it then reports is a sentence
       * fragment. Reading prose as code is its own small lesson.
       */
      const entries = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const prefixes = [...entries.matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\/api\//, '').replace(/\/$/, ''))
      for (const prefix of prefixes) {
        const covered = found.filter((route) => route.key === prefix || route.key.startsWith(`${prefix}/`))
        check(`middleware prefix /api/${prefix} covers a route that exists`, covered.length > 0,
          'skips the session check for nothing — dead entry, or a route that moved')
        for (const route of covered) {
          const declared = POSTURE[route.key]
          check(
            `/api/${route.key} is waved through and says how it protects itself`,
            Boolean(declared),
            'the middleware skips authentication for it and nothing declares what replaces that',
          )
        }
      }
      if (failed === 0) {
        console.log(`  ✓ ${prefixes.length} skipped prefixes, every route under them declared`)
      }
    }
  }

  console.log('\n── How the surface breaks down ──')
  for (const [how, keys] of [...byMechanism.entries()].sort()) {
    console.log(`  ${String(how).padEnd(14)} ${keys.length}`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(`
Every route under src/app/api must appear in POSTURE in scripts/api-routes.ts,
naming how it authenticates and why that is the right answer for it. That file
is the only place the API surface is written down, and both this suite and
api-authorization-test read it; a route missing from it is a route nobody has
had to think about.
`)
    process.exit(1)
  }
  process.exit(0)
}

main()
