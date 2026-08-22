/**
 * Scan a branch's QR, order, and watch which kitchen display it lands on.
 *
 * ── Why this exists separately ──────────────────────────────────────────────
 *
 * `branch-isolation-test` proves the query: `getKitchenQueue(restaurantId,
 * [branchId])` returns that branch's orders and no others. That is the right
 * check and it is not the whole question. The kitchen display does not choose
 * its own branch — it is handed one by `selectedBranch(user, searchParams)`,
 * which for a KITCHEN account resolves to `visibleBranchIds`, which resolves to
 * `[user.branchId]`. A correct query fed the wrong branch shows the wrong
 * tickets, and nothing at the service layer can see that.
 *
 * So this walks the whole path over real HTTP: the guest's landing screen, the
 * table lookup, the order, and then the actual `/kitchen` page fetched as the
 * kitchen staff of each branch in turn.
 *
 * ── The operational catch this also pins ────────────────────────────────────
 *
 * `visibleBranchIds` fails closed. A KITCHEN account with no branch assigned
 * gets `[]` — sees NOTHING, not everything — which is the safe answer and an
 * alarming one to meet on a busy evening. The last section asserts that, so the
 * behaviour is documented rather than discovered.
 *
 * Requires a build and a running server:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/qr-to-kitchen-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { resolveTable } from '../src/features/orders/actions'
import { placeOrder } from '../src/features/orders/service'

const BASE = process.env.BASE_URL ?? 'http://localhost:3210'

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
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    process.exit(0)
  }

  const stamp = Date.now().toString(36)

  // ── a two-branch restaurant, each with a table and a kitchen ───────────────
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `QR ${stamp}`,
      slug: `qr-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
      timezone: 'Asia/Colombo',
    },
  })

  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main Kitchen', code: 'QMAIN', isDefault: true },
  })
  const b01 = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Second Site', code: 'QB01' },
  })

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `qr-mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Rice and curry',
      slug: `qr-dish-${stamp}`,
      price: 80_000,
      isAvailable: true,
      // On both menus, so the branch of the ORDER is the only variable.
      branches: {
        create: [
          { restaurantId: restaurant.id, branchId: main.id },
          { restaurantId: restaurant.id, branchId: b01.id },
        ],
      },
    },
  })

  // The same number at both, which is the whole point: this is what used to
  // make the guest's lookup ambiguous.
  const tableMain = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '5', capacity: 4 },
  })
  const tableB01 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: b01.id, number: '5', capacity: 4 },
  })

  const chefMain = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, branchId: main.id, role: 'KITCHEN',
      name: 'Main chef', email: `chef-main-${stamp}@qr.test`,
      passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })
  const chefB01 = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, branchId: b01.id, role: 'KITCHEN',
      name: 'Second chef', email: `chef-b01-${stamp}@qr.test`,
      passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })
  const chefNowhere = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, role: 'KITCHEN',
      name: 'Unassigned chef', email: `chef-none-${stamp}@qr.test`,
      passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })

  console.log('\n── 1. the guest scans the second site’s code ──')

  const landing = await fetch(`${BASE}/order?r=${restaurant.slug}&b=QB01`, { redirect: 'manual' })
  const landingBody = landing.status === 200 ? await landing.text() : ''
  check('the landing screen opens', landing.status === 200, `HTTP ${landing.status}`)
  check(
    'and names the branch they scanned',
    landingBody.includes('Second Site'),
    'the guest cannot tell which place they are ordering from',
  )
  check(
    'and the middleware wrote the branch cookie',
    (landing.headers.get('set-cookie') ?? '').includes('ros_b=QB01'),
    landing.headers.get('set-cookie') ?? '(no set-cookie)',
  )

  console.log('\n── 2. they type table 5, which exists at BOTH branches ──')

  const seated = await resolveTable({ tableNumber: '5' }, restaurant.slug, 'QB01')
  check(
    'they are seated at the SECOND SITE’s table 5',
    seated.ok && seated.data.tableId === tableB01.id,
    seated.ok
      ? seated.data.tableId === tableMain.id
        ? 'they were seated at Main’s table 5 — the reported bug'
        : seated.data.tableId
      : seated.error,
  )

  console.log('\n── 3. they order ──')

  const order = await placeOrder({
    restaurantId: restaurant.id,
    branchId: b01.id,
    tableId: tableB01.id,
    type: 'DINE_IN',
    channel: 'QR',
    customerName: 'Guest',
    customerPhone: `07${stamp.slice(-8).padEnd(8, '0')}`,
    items: [{ foodId: dish.id, quantity: 2, optionIds: [] }],
  })
  check('the order is filed against the second site', order.branchId === b01.id, `${order.branchId}`)

  console.log('\n── 4. whose kitchen display shows it ──')

  const atB01 = await fetch(`${BASE}/kitchen`, { headers: { cookie: await signIn(chefB01) } })
  const b01Screen = atB01.status === 200 ? await atB01.text() : ''
  check(
    'the SECOND SITE’s kitchen display shows the ticket',
    b01Screen.includes(order.orderNumber),
    `HTTP ${atB01.status} — the branch that took the order cannot see it`,
  )

  const atMain = await fetch(`${BASE}/kitchen`, { headers: { cookie: await signIn(chefMain) } })
  const mainScreen = atMain.status === 200 ? await atMain.text() : ''
  check(
    'and MAIN’s kitchen display does not',
    !mainScreen.includes(order.orderNumber),
    'this is the symptom that was reported',
  )

  console.log('\n── 5. a kitchen account with no location assigned ──')

  const nowhere = await fetch(`${BASE}/kitchen`, { headers: { cookie: await signIn(chefNowhere) } })
  const nowhereScreen = nowhere.status === 200 ? await nowhere.text() : ''
  check(
    'sees nothing rather than everything',
    !nowhereScreen.includes(order.orderNumber),
    'an unassigned account was shown every branch’s tickets',
  )
  console.log(
    '    ↑ deliberate: `visibleBranchIds` fails closed. Kitchen staff must be\n' +
    '      assigned to a location on the Staff screen or their display stays empty.',
  )

  // ── clean up ──────────────────────────────────────────────────────────────
  await prisma.session.deleteMany({ where: { user: { restaurantId: restaurant.id } } })
  await prisma.orderStockDepletion.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.notification.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
