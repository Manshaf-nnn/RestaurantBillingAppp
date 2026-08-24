/**
 * A hidden menu entry is not access control. The URL has to refuse.
 *
 * ── Why this runs over HTTP and not against the functions ───────────────────
 *
 * `role-permissions-test.ts` proves the permission arithmetic and proves the
 * sidebar filter drops the item. Neither of those is the thing that stops
 * somebody. `requirePagePermission` calls `redirect('/forbidden')`, and
 * `redirect` only means anything inside a real request — so the only way to
 * prove a page is refused is to ask the server for it with a real session
 * cookie and see where it sends you.
 *
 * That distinction is the one `branch-isolation-test.ts` opens with:
 * *"Filtering is what a UI does; enforcement is what a service does, and only
 * the second survives someone editing a URL."*
 *
 * ── The two bugs it is written around ───────────────────────────────────────
 *
 *   /dashboard/links     had no server guard at all — a `'use client'` page
 *                        that any dashboard role could open.
 *   /dashboard/purchases/receive
 *                        guarded `purchase.view` while the sidebar hid it
 *                        behind `purchase.receive`.
 *
 * Both are checked below against a role that should not have them.
 *
 * Run: BASE_URL=http://localhost:3000 npx tsx --tsconfig tsconfig.test.json \
 *        scripts/role-url-refusal-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { generateToken, hashToken } from '../src/server/auth/password'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/lib/rbac'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0
const minted: string[] = []

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A signed-in browser's cookie header, exactly as the real login sets it. */
async function signIn(user: {
  id: string
  restaurantId: string | null
  role: string
  name: string
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

/**
 * Fetch a page and read what actually came back.
 *
 * ── Reading the answer correctly is most of this file ───────────────────────
 *
 * Two obvious checks are both wrong here, and both were tried:
 *
 *   the status code   `redirect()` inside a Server Component runs after the
 *                     response has begun streaming, so a refused page comes
 *                     back **200**, not 307. Asserting on a 3xx fails against
 *                     a server that is refusing perfectly.
 *
 *   the page title    `metadata` is resolved before the component body runs,
 *                     so a refused `/dashboard/settings` still arrives titled
 *                     "Settings · TableFlow" with no content under it. The
 *                     title proves nothing about whether the guard fired.
 *
 * What is reliable is that Next writes the redirect target into the streamed
 * payload. A refused page mentions `/forbidden`; a served one does not. That
 * is the same shape as `page-render-test.ts`, which reads the body for a
 * marker rather than trusting the status line.
 */
async function visit(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' })
  const body = res.status === 200 ? await res.text() : ''
  return { status: res.status, location: res.headers.get('location') ?? '', body }
}

type Visit = Awaited<ReturnType<typeof visit>>

/** The guard turned them away: the payload carries a redirect to /forbidden. */
const refused = (r: Visit) => r.body.includes('/forbidden') || r.location.includes('/forbidden')

/** The page actually rendered for them. */
const served = (r: Visit) => r.status === 200 && !r.body.includes('/forbidden')

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Refusal ${stamp}`,
      slug: `refusal-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      // Not TRIAL: the dashboard layout bounces an expired trial to
      // /trial-ended, and every check below would pass while rendering nothing.
      plan: 'GROWTH',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })

  /*
   * A manager, then the same manager with a role that removes three things.
   * MANAGER is used because it starts with almost everything — so anything
   * refused below is refused because the role took it away, not because the
   * preset never had it.
   */
  const stripped = ROLE_PERMISSIONS.MANAGER.filter(
    (p) =>
      p !== PERMISSIONS.STAFF_MANAGE &&
      p !== PERMISSIONS.STAFF_VIEW &&
      p !== PERMISSIONS.PURCHASE_RECEIVE &&
      p !== PERMISSIONS.REPORT_PROFIT,
  )
  const role = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: `Floor manager ${stamp}`,
      preset: 'MANAGER',
      branchId: branch.id,
      permissions: stripped,
    },
  })

  const person = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `refusal-${stamp}@test.local`,
      name: 'Test Manager',
      passwordHash: 'x',
      role: 'MANAGER',
      branchId: branch.id,
    },
  })

  console.log(`\n── before the role is attached, a manager reaches all three ──`)
  const asManager = await signIn(person)

  const openBefore = await visit('/dashboard/staff', asManager)
  check('/dashboard/staff opens', served(openBefore), `${openBefore.status}`)
  const receiveBefore = await visit('/dashboard/purchases/receive', asManager)
  check('/dashboard/purchases/receive opens', served(receiveBefore), `${receiveBefore.status}`)
  const profitBefore = await visit('/dashboard/reports/profit', asManager)
  check('/dashboard/reports/profit opens', served(profitBefore), `${profitBefore.status}`)

  console.log(`\n── with the features switched off, the URL is refused ──`)
  await prisma.user.update({ where: { id: person.id }, data: { staffRoleId: role.id } })

  /*
   * The SAME cookie. No new session, no re-login. The JWT carries only `sub`
   * and `sid`, and the permissions are re-read per request — so an owner's edit
   * has to bite on the very next navigation. This is Rolelogic §9 tested
   * directly rather than asserted.
   */
  const links = await visit('/dashboard/links', asManager)
  check(
    '/dashboard/links is refused',
    refused(links),
    `${links.status} — page rendered`,
  )

  const staff = await visit('/dashboard/staff', asManager)
  check('/dashboard/staff is refused', refused(staff), `${staff.status} — page rendered`)

  const receive = await visit('/dashboard/purchases/receive', asManager)
  check(
    '/dashboard/purchases/receive is refused',
    refused(receive),
    `${receive.status} — page rendered`,
  )

  const profit = await visit('/dashboard/reports/profit', asManager)
  check(
    '/dashboard/reports/profit is refused',
    refused(profit),
    `${profit.status} — page rendered`,
  )

  console.log(`\n── and what was left on still works ──`)
  const orders = await visit('/dashboard/orders', asManager)
  check('/dashboard/orders still opens', served(orders), `${orders.status}`)
  const reports = await visit('/dashboard/reports', asManager)
  check('the reports hub still opens', served(reports), `${reports.status}`)
  const sales = await visit('/dashboard/reports/sales', asManager)
  check('and the sales report, which was never switched off', served(sales), `${sales.status}`)

  console.log(`\n── switching one back on takes effect at once ──`)
  await prisma.staffRole.update({
    where: { id: role.id },
    data: { permissions: [...stripped, PERMISSIONS.REPORT_PROFIT] },
  })
  const profitAgain = await visit('/dashboard/reports/profit', asManager)
  check(
    '/dashboard/reports/profit opens again on the same session',
    served(profitAgain),
    `${profitAgain.status}`,
  )

  // ── cleanup ─────────────────────────────────────────────────────────────
  await prisma.session.deleteMany({ where: { id: { in: minted } } })
  await prisma.user.updateMany({
    where: { restaurantId: restaurant.id },
    data: { staffRoleId: null },
  })
  await prisma.staffRole.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
