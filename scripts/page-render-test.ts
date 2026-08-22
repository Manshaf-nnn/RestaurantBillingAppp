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
  '/dashboard/inventory/setup',
  '/dashboard/purchases',
  '/dashboard/purchases/receive',
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

const minted: string[] = []

/** A signed-in browser's cookie header for this user, as the real login sets it. */
async function signIn(user: { id: string; restaurantId: string | null; role: string; name: string | null; email: string }) {
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
  } as Parameters<typeof signAccessToken>[0])
  minted.push(session.id)
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

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

  const cookie = await signIn(user)

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
   * The detail routes, which take an id and so cannot be listed as constants.
   *
   * `/dashboard/production/[orderId]` in particular did not exist at all while
   * the traceability panel linked to it, so every "where did this stock come
   * from" trail that ended at a production run ended at a 404. A route nothing
   * renders in CI is a route nobody notices is missing.
   */
  const [aRun, aTransfer, aLocation] = await Promise.all([
    prisma.productionOrder.findFirst({
      where: { restaurantId: user.restaurantId ?? undefined },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.stockTransfer.findFirst({
      where: { restaurantId: user.restaurantId ?? undefined },
      select: { id: true },
      orderBy: { requestedAt: 'desc' },
    }),
    prisma.branch.findFirst({
      where: { restaurantId: user.restaurantId ?? undefined, deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const detailPages = [
    aRun ? `/dashboard/production/${aRun.id}` : null,
    aTransfer ? `/dashboard/transfers/${aTransfer.id}` : null,
    aLocation ? `/dashboard/locations/${aLocation.id}` : null,
  ].filter((path): path is string => path !== null)

  if (detailPages.length === 0) {
    console.log('\nNo runs or transfers on the fixture tenant — detail routes not checked.')
  } else {
    console.log('\nDetail routes')
    for (const path of detailPages) {
      const response = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' })
      const body = response.status === 200 ? await response.text() : ''
      const boundary = BOUNDARY.find((needle) => body.includes(needle))

      if (response.status === 200 && !boundary) {
        passed += 1
        console.log(`  ✓ ${path}`)
      } else {
        failed.push(path)
        console.log(`  ✗ ${path} — ${boundary ? `rendered "${boundary}"` : `HTTP ${response.status}`}`)
      }
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

    /*
     * And the switch actually takes.
     *
     * Rendering without error is not the same as rendering the branch that was
     * asked for — the reported bug was a page that returned 200 and showed the
     * wrong location's figures. So fetch the dashboard for two different
     * branches and require the responses to differ and each to name its own.
     *
     * This pins the server half. The half that broke was Next's client
     * prefetch cache, which no server-side fetch can exercise; that one is
     * checked by clicking it.
     */
    /*
     * On a tenant with two locations — not necessarily the one above, since most
     * restaurants in this database have a single site and the check would then
     * never run. Signing in as that tenant's owner is a few lines and makes the
     * assertion mean something on every database.
     */
    const counts = await prisma.branch.groupBy({
      by: ['restaurantId'],
      where: { deletedAt: null, isActive: true },
      _count: { _all: true },
    })
    const multiSite = counts.filter((row) => row._count._all > 1).map((row) => row.restaurantId)

    const twoBranchOwner = multiSite.length
      ? await prisma.user.findFirst({
          where: { restaurantId: { in: multiSite }, role: 'OWNER', isActive: true, deletedAt: null },
          select: { id: true, restaurantId: true, role: true, name: true, email: true },
        })
      : null

    const two = twoBranchOwner
      ? await prisma.branch.findMany({
          where: { restaurantId: twoBranchOwner.restaurantId ?? undefined, deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' },
          take: 2,
        })
      : []

    if (twoBranchOwner && two.length === 2 && two[0].name !== two[1].name) {
      const theirs = await signIn(twoBranchOwner)
      const [a, b] = await Promise.all(
        two.map((row) =>
          fetch(`${BASE}/dashboard?branch=${row.id}`, { headers: { cookie: theirs } }).then((r) => r.text()),
        ),
      )

      /*
       * The marker is `branch=<id>` in the nav links, not the branch NAME.
       * Every location's name and id appear in both responses regardless —
       * the switcher lists all of them — so a name check passes even when the
       * wrong branch rendered. The shell threads the ACTIVE branch through
       * every sidebar link, so that query string appears for the selected
       * branch and no other. It is the page saying which branch it thinks it
       * is on, which is precisely what was reported wrong.
       */
      const correct =
        a.includes(`branch=${two[0].id}`) && !a.includes(`branch=${two[1].id}`) &&
        b.includes(`branch=${two[1].id}`) && !b.includes(`branch=${two[0].id}`)

      if (correct) {
        passed += 1
        console.log(`  ✓ /dashboard follows ?branch= (${two[0].name} vs ${two[1].name})`)
      } else {
        failed.push('/dashboard?branch= served the wrong branch')
        console.log(
          `  ✗ /dashboard did not follow ?branch= — ${a === b ? 'identical HTML for both' : 'named the wrong location'}`,
        )
      }
    } else {
      console.log('  · no multi-location tenant in this database — branch switching not checked')
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

  await prisma.session.deleteMany({ where: { id: { in: minted } } }).catch(() => {})
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
