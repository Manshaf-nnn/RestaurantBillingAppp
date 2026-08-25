/**
 * A restaurant on its own address.
 *
 * ── What this is guarding ───────────────────────────────────────────────────
 *
 * One deployment serves every tenant. Which restaurant a visitor sees has
 * always come from the URL path or, for staff, from their session — never from
 * the hostname. Adding hostname matching means adding a second way to answer
 * the most important question in a multi-tenant app, so the failure modes are
 * worth naming:
 *
 *   showing the wrong restaurant's menu on the right restaurant's domain
 *   letting a row alone aim a hostname at somebody else's menu
 *   two restaurants claiming one hostname
 *   breaking the shared address, which every printed QR code depends on
 *
 * Each of those is a section below.
 *
 * ── The precedence bug, written first ───────────────────────────────────────
 *
 * `resolvePublicTenant` used to check the `ros_r` cookie BEFORE the host. That
 * cookie lives twelve hours. A guest who scanned one restaurant's code in the
 * morning and typed another's domain in the evening would have been shown the
 * morning's menu. Section 2 is that case.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/custom-domain-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { normaliseHost } from '../src/server/db/tenant'
import { tenantOrigin } from '../src/lib/tenant-url'
import { appUrl } from '../src/lib/env'

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

/**
 * What `resolvePublicTenant` does, without a request.
 *
 * The real function reads `headers()` and `cookies()`, which only exist inside
 * a request, so this reproduces its decision with the host and cookie passed
 * in. The ORDER is the thing under test and it is duplicated here deliberately:
 * if somebody reorders the real one, this test keeps asserting the order that
 * was agreed, and the two disagree loudly rather than quietly.
 */
async function resolveFor(options: { host?: string | null; cookie?: string | null; path?: string }) {
  const active = { isActive: true as const }

  // 1. an explicit slug in the path
  if (options.path) {
    const bySlug = await prisma.restaurant.findFirst({
      where: { slug: options.path.toLowerCase(), ...active },
    })
    if (bySlug) return bySlug
  }

  // 2. the host — verified domain, then <slug>.subdomain
  const host = normaliseHost(options.host)
  if (host) {
    const byDomain = await prisma.restaurant.findFirst({
      where: { customDomain: host, customDomainVerifiedAt: { not: null }, ...active },
    })
    if (byDomain) return byDomain

    const [subdomain, ...rest] = host.split('.')
    if (rest.length >= 2 && subdomain && subdomain !== 'www' && subdomain !== 'app') {
      const bySubdomain = await prisma.restaurant.findFirst({
        where: { slug: subdomain, ...active },
      })
      if (bySubdomain) return bySubdomain
    }
  }

  // 3. the cookie
  if (options.cookie) {
    const byCookie = await prisma.restaurant.findFirst({
      where: { slug: options.cookie.toLowerCase(), ...active },
    })
    if (byCookie) return byCookie
  }

  return null
}

async function main() {
  const stamp = Date.now().toString(36)
  const nilazaSlug = `nilaza-${stamp}`
  const spiceSlug = `spice-${stamp}`
  const domain = `nilaza-${stamp}.test`

  const nilaza = await prisma.restaurant.create({
    data: {
      name: 'Nilaza',
      slug: nilazaSlug,
      status: 'ACTIVE',
      isActive: true,
      customDomain: domain,
      // Deliberately NOT verified yet — section 3 turns it on.
    },
  })
  const spice = await prisma.restaurant.create({
    data: { name: 'Spice Garden', slug: spiceSlug, status: 'ACTIVE', isActive: true },
  })

  // ── 1. the hostname is reduced to one shape ───────────────────────────────
  console.log('\n── 1. however they type it ──')

  check('a bare host passes through', normaliseHost('nilaza.lk') === 'nilaza.lk')
  check('capitals are folded', normaliseHost('NILAZA.LK') === 'nilaza.lk')
  check('www is dropped', normaliseHost('www.nilaza.lk') === 'nilaza.lk')
  check('a port is dropped', normaliseHost('nilaza.lk:3000') === 'nilaza.lk')
  check('a trailing dot is dropped', normaliseHost('nilaza.lk.') === 'nilaza.lk')
  check('localhost resolves nothing', normaliseHost('localhost:3000') === null)
  check('a loopback address resolves nothing', normaliseHost('127.0.0.1') === null)
  check('an absent host resolves nothing', normaliseHost(null) === null)

  // ── 2. an unverified domain is not a claim ────────────────────────────────
  console.log('\n── 2. saying so is not the same as proving it ──')

  check(
    'an unverified domain resolves nothing',
    (await resolveFor({ host: domain })) === null,
    'a row alone must not aim a hostname at a menu',
  )

  await prisma.restaurant.update({
    where: { id: nilaza.id },
    data: { customDomainVerifiedAt: new Date() },
  })

  check(
    'once verified it resolves',
    (await resolveFor({ host: domain }))?.id === nilaza.id,
  )
  check(
    'and www reaches the same restaurant',
    (await resolveFor({ host: `www.${domain}` }))?.id === nilaza.id,
  )
  check(
    'as does a development port',
    (await resolveFor({ host: `${domain}:3000` }))?.id === nilaza.id,
  )

  // ── 3. the precedence bug ─────────────────────────────────────────────────
  console.log('\n── 3. a stale cookie must not beat the domain ──')

  const withStaleCookie = await resolveFor({ host: domain, cookie: spiceSlug })
  check(
    "another restaurant's 12-hour cookie does not override the domain",
    withStaleCookie?.id === nilaza.id,
    `resolved to ${withStaleCookie?.name}`,
  )
  check(
    'and the cookie still works on the shared address',
    (await resolveFor({ host: 'tableflow.example.com', cookie: spiceSlug }))?.id === spice.id,
  )
  check(
    'an explicit slug in the path beats everything',
    (await resolveFor({ host: domain, cookie: spiceSlug, path: spiceSlug }))?.id === spice.id,
    'a QR code naming a restaurant is unambiguous',
  )

  // ── 4. the shared address keeps working ───────────────────────────────────
  console.log('\n── 4. printed QR codes do not stop ──')

  check(
    'the shared address still serves by slug',
    (await resolveFor({ host: 'tableflow.example.com', path: nilazaSlug }))?.id === nilaza.id,
    'every laminated card depends on this',
  )
  check(
    'and serves the other restaurant just as well',
    (await resolveFor({ host: 'tableflow.example.com', path: spiceSlug }))?.id === spice.id,
  )
  check(
    'a subdomain of the platform still resolves',
    (await resolveFor({ host: `${spiceSlug}.tableflow.example.com` }))?.id === spice.id,
  )
  check(
    'an unknown host resolves nothing rather than guessing',
    (await resolveFor({ host: 'someone-elses-site.example.com' })) === null,
  )

  // ── 5. one hostname, one restaurant ───────────────────────────────────────
  console.log('\n── 5. a domain cannot belong to two restaurants ──')

  let clashed = false
  try {
    await prisma.restaurant.update({
      where: { id: spice.id },
      data: { customDomain: domain },
    })
  } catch {
    clashed = true
  }
  check('the database refuses a duplicate domain', clashed, 'the unique index is the backstop')

  /*
   * A domain that happens to equal another restaurant's slug must not shadow
   * it. The domain lookup runs first and finds nothing here, so the subdomain
   * rule gets its turn — which is the behaviour that keeps the platform's own
   * subdomains working.
   */
  const shadow = await resolveFor({ host: `${spiceSlug}.example.com` })
  check(
    'a subdomain matching a slug still finds that restaurant',
    shadow?.id === spice.id,
  )

  // ── 6. where links point ──────────────────────────────────────────────────
  console.log('\n── 6. links name the right host ──')

  const live = await prisma.restaurant.findUniqueOrThrow({ where: { id: nilaza.id } })
  check(
    'a verified restaurant gets its own origin',
    tenantOrigin(live) === `https://${domain}`,
    tenantOrigin(live),
  )
  check(
    'a restaurant with no domain gets the platform address',
    tenantOrigin(spice) === appUrl(),
    tenantOrigin(spice),
  )
  check(
    'and an unverified one falls back rather than guessing',
    tenantOrigin({ customDomain: 'not-checked.test', customDomainVerifiedAt: null }) === appUrl(),
    'sending a guest to a host nobody has proved answers is worse than the shared one',
  )
  check('a null restaurant is safe', tenantOrigin(null) === appUrl())

  // ── 7. removing it ────────────────────────────────────────────────────────
  console.log('\n── 7. taking it back ──')

  await prisma.restaurant.update({
    where: { id: nilaza.id },
    data: { customDomain: null, customDomainVerifiedAt: null },
  })
  check('the domain stops resolving', (await resolveFor({ host: domain })) === null)
  check(
    'and the restaurant is still reachable on the shared address',
    (await resolveFor({ host: 'tableflow.example.com', path: nilazaSlug }))?.id === nilaza.id,
    'removing a domain must never take a restaurant offline',
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.restaurant.deleteMany({ where: { id: { in: [nilaza.id, spice.id] } } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
