/**
 * Every report, under each filter the toolbar can actually set.
 *
 * ── Why this exists next to page-render-test ────────────────────────────────
 *
 * `page-render-test` already sweeps every dashboard page twice, once plain and
 * once with `?branch=`. It reported a clean 130 while the Purchasing report
 * threw for every multi-location tenant that picked a location, and it did so
 * for a reason worth writing down: its branch pass runs as the FIRST active
 * owner in the database, and most restaurants here have one site. With a
 * single location the report's `chosen` is that one branch either way, the
 * query shape never changes, and the branch-only code path is never entered.
 *
 * The bug was `where: { purchase: { branchId } }` on `PurchasePriceHistory`, a
 * model with no `purchase` relation. Prisma rejects an unknown argument before
 * it reads a row, so it threw on an empty table, on every tenant, every time —
 * and still nothing caught it, because the sweep's tenant never took that
 * branch of the code.
 *
 * So this pins the filters as a matrix rather than as one pass: a tenant with
 * two locations, each report, each location, and a date preset alongside. A
 * loader written restaurant-wide and handed a branch is a whole class of
 * defect, and it only appears when something narrows.
 *
 * Usage:
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/report-filter-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { renderFailure } from './streamed-error'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

/** Screens whose loaders narrow on a location. */
const FILTERED = [
  '/dashboard/reports/sales',
  '/dashboard/reports/profit',
  '/dashboard/reports/inventory',
  '/dashboard/reports/purchasing',
  '/dashboard/reports/variance',
  '/dashboard/reports/reconciliation',
  '/dashboard/reports/cash-drawer',
  '/dashboard/reports/petty-cash',
  '/dashboard/insights',
  '/dashboard/insights/menu',
  '/dashboard/insights/inventory',
  '/dashboard/insights/waste',
  '/dashboard/analytics',
  '/dashboard/transfers/report',
]

/** Periods the toolbar offers. A range that resolves differently is a different query. */
const PRESETS = ['TODAY', 'THIS_MONTH', 'LAST_MONTH']

/** The purchasing report's own views, which change which loaders run. */
const VIEWS = ['overview', 'orders', 'item', 'supplier']

const minted: string[] = []

async function signIn(user: {
  id: string
  restaurantId: string | null
  role: string
  name: string | null
  email: string
}) {
  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const access = await signAccessToken({
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    name: user.name,
    email: user.email,
    sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  minted.push(session.id)
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

let passed = 0
const failures: string[] = []

async function open(cookie: string, url: string, label: string) {
  const response = await fetch(`${BASE}${url}`, { headers: { cookie }, redirect: 'manual' })
  const body = response.status === 200 ? await response.text() : ''

  if (response.status === 200) {
    const failure = renderFailure(response.status, body)
    if (!failure) {
      passed += 1
      return
    }
    failures.push(`${label} — ${failure}`)
    console.log(`  ✗ ${label} — ${failure}`)
    return
  }
  /*
   * A redirect is a permission decision, not a render failure — but only to
   * somewhere that IS one. Being bounced to login or trial-ended means the
   * fixture is blocked and nothing was tested, which must not read as a pass.
   */
  if (response.status >= 300 && response.status < 400) {
    const target = response.headers.get('location') ?? ''
    if (/\/(trial-ended|pending-approval|login|onboarding)/.test(target)) {
      failures.push(`${label} — never rendered, redirected to ${target}`)
      console.log(`  ✗ ${label} → ${target} (fixture blocked, nothing tested)`)
      return
    }
    passed += 1
    return
  }
  failures.push(`${label} — HTTP ${response.status}`)
  console.log(`  ✗ ${label} — HTTP ${response.status}`)
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  /*
   * A tenant with TWO locations, because that is the only shape where picking
   * one narrows anything. On a single-site tenant `scopeToOne` returns that
   * site whether or not `?branch=` is present, so every assertion below would
   * pass without exercising the filter at all.
   */
  const counts = await prisma.branch.groupBy({
    by: ['restaurantId'],
    where: { deletedAt: null },
    _count: { _all: true },
    having: { restaurantId: { _count: { gte: 2 } } },
  })

  let owner = null
  let branches: Array<{ id: string; name: string }> = []
  for (const row of counts) {
    const candidate = await prisma.user.findFirst({
      where: {
        restaurantId: row.restaurantId,
        role: 'OWNER',
        isActive: true,
        deletedAt: null,
        restaurant: {
          status: 'ACTIVE',
          isActive: true,
          OR: [{ plan: { not: 'TRIAL' } }, { trialEndsAt: null }, { trialEndsAt: { gt: new Date() } }],
        },
      },
      include: { restaurant: { select: { name: true } } },
    })
    if (!candidate) continue
    branches = await prisma.branch.findMany({
      where: { restaurantId: row.restaurantId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    })
    if (branches.length >= 2) {
      owner = candidate
      break
    }
  }

  if (!owner || branches.length < 2) {
    console.log('No active owner of a two-location tenant in this database — skipping.')
    console.log('This check needs one to mean anything; a single-site tenant never narrows.')
    process.exit(0)
  }

  const cookie = await signIn(owner)
  console.log(
    `owner ${owner.email} · ${owner.restaurant?.name} · ` +
    `${branches.map((b) => b.name).join(' + ')}\n`,
  )

  console.log('── Each report, at each location ──')
  for (const path of FILTERED) {
    const before = failures.length
    for (const branch of branches) {
      await open(cookie, `${path}?branch=${branch.id}`, `${path} @ ${branch.name}`)
    }
    if (failures.length === before) console.log(`  ✓ ${path} — both locations`)
  }

  console.log('\n── Location crossed with each period ──')
  for (const preset of PRESETS) {
    const before = failures.length
    for (const path of FILTERED) {
      await open(cookie, `${path}?branch=${branches[0].id}&preset=${preset}`, `${path} @ ${preset}`)
    }
    if (failures.length === before) console.log(`  ✓ every report at ${preset}, with a location`)
  }

  console.log('\n── The purchasing report\'s views, with a location ──')
  for (const view of VIEWS) {
    const beforeView = failures.length
    await open(
      cookie,
      `/dashboard/reports/purchasing?branch=${branches[0].id}&view=${view}`,
      `purchasing view=${view} @ branch`,
    )
    // Page 2 of a drill-down is a different slice and a different href.
    await open(
      cookie,
      `/dashboard/reports/purchasing?branch=${branches[0].id}&view=${view}&page=2`,
      `purchasing view=${view} page=2 @ branch`,
    )
    if (failures.length === beforeView) console.log(`  ✓ view=${view}, page 1 and 2`)
  }

  console.log('\n── Filters that should be refused, not crash ──')
  const nonsense = [
    ['a branch id that does not exist', `?branch=does-not-exist`],
    ['a branch id from another tenant', `?branch=${(await otherTenantBranch(owner.restaurantId)) ?? 'none'}`],
    ['an unknown preset', `?branch=${branches[0].id}&preset=NOT_A_PRESET`],
    ['a malformed date', `?branch=${branches[0].id}&preset=CUSTOM&from=banana&to=also-banana`],
    ['a reversed range', `?branch=${branches[0].id}&preset=CUSTOM&from=2030-01-01&to=2020-01-01`],
    ['a negative page', `?branch=${branches[0].id}&view=orders&page=-5`],
    ['a page past the end', `?branch=${branches[0].id}&view=orders&page=99999`],
  ] as const
  for (const [label, query] of nonsense) {
    const beforeCase = failures.length
    await open(cookie, `/dashboard/reports/purchasing${query}`, `purchasing with ${label}`)
    if (failures.length === beforeCase) console.log(`  ✓ ${label}`)
  }

  await prisma.session.deleteMany({ where: { id: { in: minted } } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failures.length} failed ═══\n`)
  if (failures.length) {
    for (const failure of failures) console.log(`  ✗ ${failure}`)
    process.exit(1)
  }
  process.exit(0)
}

/** A branch belonging to some OTHER tenant, to point this one's filter at. */
async function otherTenantBranch(restaurantId: string | null): Promise<string | null> {
  const branch = await prisma.branch.findFirst({
    where: { deletedAt: null, restaurantId: { not: restaurantId ?? undefined } },
    select: { id: true },
  })
  return branch?.id ?? null
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
