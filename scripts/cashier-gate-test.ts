/**
 * A till operator cannot work before they have a drawer open.
 *
 * ── Why this has to be a runtime test ───────────────────────────────────────
 *
 * The gate is a `redirect()` from inside a Server Component and a layout, and
 * neither is observable from a service test: `requireCashierSession` throws the
 * framework's navigation signal, and nothing about a unit test can tell that
 * apart from a crash. `isTillOperator` is unit-tested in cash-drawer-test §10 —
 * that proves who *should* be gated. This proves they actually are.
 *
 * It also covers the failure mode that makes an interstitial dangerous rather
 * than merely annoying: locking somebody out with no way forward and no way
 * back. Hence the owner case and the sign-out case.
 *
 * A redirect from a Server Component returns HTTP 200, not a 3xx — the response
 * is already streaming by the time it happens — so the signal is the
 * destination appearing in the streamed body, not a Location header. Both are
 * checked, because the layout's redirect and the page's behave differently.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/cashier-gate-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { ensureRegister } from '../src/features/cashdrawer/registers'

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

async function cookiesFor(user: { id: string; restaurantId: string | null; role: string }) {
  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  minted.push(session.id)
  const access = await signAccessToken({
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

/** Did this response send the visitor to the session screen, by either route? */
function gated(res: { location: string | null; body: string }) {
  return res.body.includes('/cashier/session') || (res.location?.includes('/cashier/session') ?? false)
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  /*
   * An existing live tenant, and one inside its trial: the dashboard layout
   * bounces an expired trial to /trial-ended before the gate ever runs, and the
   * whole file would then pass while proving nothing.
   */
  const owner = await prisma.user.findFirst({
    where: {
      role: 'OWNER',
      restaurantId: { not: null },
      restaurant: {
        status: 'ACTIVE',
        isActive: true,
        OR: [{ plan: { not: 'TRIAL' } }, { trialEndsAt: null }, { trialEndsAt: { gt: new Date() } }],
      },
    },
    include: { restaurant: { select: { id: true } } },
  })
  if (!owner?.restaurantId) {
    console.log('No active tenant to probe — skipping.')
    process.exit(0)
  }

  const branch = await prisma.branch.findFirstOrThrow({
    where: { restaurantId: owner.restaurantId, deletedAt: null, isActive: true },
  })
  const register = await ensureRegister({
    restaurantId: owner.restaurantId,
    branchId: branch.id,
  })

  const stamp = Date.now().toString(36)
  const cashier = await prisma.user.create({
    data: {
      restaurantId: owner.restaurantId,
      email: `gate-${stamp}@test.local`,
      name: 'Gate Cashier',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: branch.id,
    },
  })

  const asCashier = await cookiesFor(cashier)
  const asOwner = await cookiesFor(owner)

  const hit = async (path: string, cookie: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' })
    const body = res.status >= 300 && res.status < 400 ? '' : await res.text()
    return { status: res.status, location: res.headers.get('location'), body }
  }

  console.log('\n── with no drawer open ──')

  const atTill = await hit('/cashier', asCashier)
  check('a cashier is sent to the session screen', gated(atTill), `status ${atTill.status}`)

  const atPos = await hit('/cashier/pos', asCashier)
  check('and so is the POS, which also takes money', gated(atPos), `status ${atPos.status}`)

  const atDashboard = await hit('/dashboard', asCashier)
  check(
    'typing the dashboard URL does not get round it',
    gated(atDashboard),
    'CASHIER is on the middleware allow-list for /dashboard, so the page has to say no',
  )

  const screen = await hit('/cashier/session', asCashier)
  check(
    'the session screen renders',
    screen.status === 200 && screen.body.includes('Start your shift'),
    `status ${screen.status}`,
  )
  check(
    'and always offers a way out',
    screen.body.includes('Sign out'),
    'somebody who cannot open a drawer must never be trapped there',
  )

  console.log('\n── who is not gated ──')

  const ownerAtDashboard = await hit('/dashboard', asOwner)
  check(
    'an owner with no drawer reaches their own dashboard',
    !gated(ownerAtDashboard),
    'the gate must never lock a manager out of the business',
  )

  console.log('\n── once the drawer is open ──')

  const opened = await prisma.cashDrawerSession.create({
    data: {
      restaurantId: owner.restaurantId,
      branchId: branch.id,
      registerId: register.id,
      sessionNumber: `CD-TEST-${stamp}`,
      openedById: cashier.id,
      openingFloat: 1_000_00,
      activeCashierKey: cashier.id,
      // Not the real register key: another test's till may legitimately hold
      // it, and this session is a probe rather than a claim on the counter.
      activeRegisterKey: `probe-${stamp}`,
    },
  })

  const afterOpening = await hit('/dashboard', asCashier)
  check('the dashboard opens normally', !gated(afterOpening), `status ${afterOpening.status}`)

  const tillAfter = await hit('/cashier', asCashier)
  check('and so does the till', !gated(tillAfter), `status ${tillAfter.status}`)

  const backToScreen = await hit('/cashier/session', asCashier)
  check(
    'the session screen bounces them back rather than asking twice',
    !backToScreen.body.includes('Start your shift'),
    `status ${backToScreen.status}`,
  )

  // ── cleanup ────────────────────────────────────────────────────────────────
  await prisma.cashDrawerSession.delete({ where: { id: opened.id } })
  await prisma.session.deleteMany({ where: { id: { in: minted } } })
  await prisma.user.delete({ where: { id: cashier.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
