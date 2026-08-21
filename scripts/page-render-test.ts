/**
 * Load every dashboard page as a signed-in owner and assert it renders.
 *
 * The static checks cannot prove this. `no-function-props.ts` proves no function
 * crosses the server/client boundary, and `qa-suite.ts` proves the queries are
 * right, but neither renders anything — and the Reports and Customer-insights
 * crash lived precisely in the gap between them: the loader returned fine and
 * React then failed to encode the tree. `npx next build` did not catch it either,
 * because those pages are `force-dynamic` and never prerendered.
 *
 * So this fetches the real pages from a real server and fails on the error
 * boundary's own text. It is the only check that would have caught that bug.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/page-render-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

/** Pages an owner should be able to open. Add new ones here. */
const PAGES = [
  '/dashboard',
  '/dashboard/help',
  '/dashboard/tasks',
  '/dashboard/reports',
  '/dashboard/reports/sales',
  '/dashboard/reports/profit',
  '/dashboard/reports/inventory',
  '/dashboard/reports/purchasing',
  '/dashboard/reports/variance',
  '/dashboard/reports/reconciliation',
  '/dashboard/customers',
  '/dashboard/customers/analytics',
  '/dashboard/locations',
  '/dashboard/transfers',
  '/dashboard/transfers/new',
  '/dashboard/production',
  '/dashboard/inventory',
  '/dashboard/inventory/wastage',
  '/dashboard/inventory/counts',
  '/dashboard/inventory/expiry',
  '/dashboard/purchases',
  '/dashboard/suppliers',
  '/dashboard/recipes',
  '/dashboard/staff',
  '/dashboard/staff/codes',
  '/dashboard/menu',
  '/dashboard/orders',
  '/dashboard/tables',
  '/dashboard/settings',
  '/dashboard/loyalty',
  '/dashboard/coupons',
  '/dashboard/approvals',
  '/dashboard/audit-logs',
  '/dashboard/analytics',
  '/dashboard/feedback',
  '/dashboard/reviews',
  '/dashboard/reservations',
  '/dashboard/qr',
  '/dashboard/handover',
  '/dashboard/cash-drawer',
  '/dashboard/online-payments',
]

/** The dashboard error boundary's own words — the failure signal. */
const BOUNDARY = ['This page could not load', 'Something went wrong', 'Application error']

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  /*
   * The tenant must also be inside its trial, or the layout redirects every
   * page to /trial-ended and this whole run passes while rendering nothing.
   * That happened on the first attempt and looked like a clean sweep.
   */
  const user = await prisma.user.findFirst({
    where: {
      role: 'OWNER',
      isActive: true,
      deletedAt: null,
      restaurant: {
        status: 'ACTIVE',
        isActive: true,
        OR: [
          { plan: { not: 'TRIAL' } },
          { trialEndsAt: null },
          { trialEndsAt: { gt: new Date() } },
        ],
      },
    },
    include: { restaurant: { select: { name: true, currency: true, locale: true, plan: true, trialEndsAt: true } } },
  })
  if (!user?.restaurant) {
    console.error(
      'No owner of an active, in-trial restaurant in this database.\n' +
      'Every page would redirect to /trial-ended and nothing would actually render.',
    )
    process.exit(1)
  }

  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const access = await signAccessToken({
    sub: user.id, rid: user.restaurantId, role: user.role,
    name: user.name, email: user.email, sid: session.id,
  })
  const cookie = `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`

  console.log(`owner ${user.email} · ${user.restaurant.name} · ${user.restaurant.currency}/${user.restaurant.locale}\n`)

  let passed = 0
  const failed: string[] = []

  for (const path of PAGES) {
    const response = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' })
    const body = response.status === 200 ? await response.text() : ''
    const boundary = BOUNDARY.find((needle) => body.includes(needle))

    if (response.status === 200 && !boundary) {
      passed += 1
      console.log(`  ✓ ${path}`)
    } else if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get('location') ?? ''
      /*
       * A redirect to /forbidden is a real permission decision. A redirect to
       * /trial-ended or /pending-approval is not — it means the fixture tenant
       * is blocked and this page was never rendered, so counting it as a pass
       * would report a clean sweep having tested nothing.
       */
      if (/\/(trial-ended|pending-approval|login|onboarding)/.test(target)) {
        failed.push(`${path} (never rendered → ${target})`)
        console.log(`  ✗ ${path} → ${target} — tenant blocked, nothing was tested`)
      } else {
        passed += 1
        console.log(`  · ${path} → ${target} (permission redirect)`)
      }
    } else {
      failed.push(path)
      console.log(`  ✗ ${path} — ${boundary ? `rendered "${boundary}"` : `HTTP ${response.status}`}`)
    }
  }

  /*
   * Every page again, this time with a location chosen.
   *
   * The top-bar switcher appends `?branch=`, and each page now resolves it
   * through `selectedBranch()` into a real predicate. A branch id reaching a
   * loader that was written restaurant-wide is exactly the kind of change that
   * renders fine in development and throws on a cold serverless request, so it
   * is checked the same way the plain pass is.
   */
  const branch = await prisma.branch.findFirst({
    where: { restaurantId: user.restaurantId ?? undefined, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  })

  if (!branch) {
    console.log('\nNo location on the fixture tenant — skipping the branch-scoped pass.')
  } else {
    console.log(`\nWith "${branch.name}" selected`)
    for (const path of PAGES) {
      const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}branch=${branch.id}`
      const response = await fetch(url, { headers: { cookie }, redirect: 'manual' })
      const body = response.status === 200 ? await response.text() : ''
      const boundary = BOUNDARY.find((needle) => body.includes(needle))

      if (response.status === 200 && !boundary) {
        passed += 1
        console.log(`  ✓ ${path}`)
      } else if (response.status >= 300 && response.status < 400) {
        passed += 1
        console.log(`  · ${path} → ${response.headers.get('location') ?? ''}`)
      } else {
        failed.push(`${path}?branch=`)
        console.log(`  ✗ ${path} — ${boundary ? `rendered "${boundary}"` : `HTTP ${response.status}`}`)
      }
    }
  }

  // The diagnostics are only worth anything if they answer, so check them here
  // rather than discovering they 500 at the moment something else is on fire.
  console.log('\nDiagnostics')
  for (const [path, describe] of [
    ['/api/health/db', (d: Record<string, unknown>) => `healthy=${d.healthy} migrations=${d.migrationsApplied}`],
    ['/api/health/pages', (d: Record<string, unknown>) => {
      const t = d.tenant as Record<string, unknown> | undefined
      const failing = (d.failing as unknown[] | undefined) ?? []
      return `healthy=${d.healthy} failing=${failing.length} currency=${t?.currency} tz=${t?.timezone} locale=${t?.locale}`
    }],
    ['/api/health/errors', (d: Record<string, unknown>) => `recorded=${d.count}`],
  ] as const) {
    const response = await fetch(`${BASE}${path}`, { headers: { cookie } })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const ok = response.status === 200
    if (ok) passed += 1
    else failed.push(path)
    console.log(`  ${ok ? '✓' : '✗'} ${path} — ${ok ? describe(body) : `HTTP ${response.status} ${JSON.stringify(body).slice(0, 80)}`}`)
  }

  await prisma.session.delete({ where: { id: session.id } }).catch(() => {})
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} rendered, ${failed.length} failed ═══\n`)
  if (failed.length > 0) {
    console.error('Failing pages:\n' + failed.map((p) => `  ${p}`).join('\n'))
    console.error('\nCheck /api/health/errors on that server for the real message.')
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
