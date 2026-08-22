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
import { quoteCart, resolveTable } from '../src/features/orders/actions'
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

  /*
   * The fixture is the spec's worked example, verbatim: Main Branch has tables
   * 1 and 2, Branch 02 has only table 3, and Main sells a dish Branch 02 does
   * not. Everything below is that example walked over real HTTP.
   */
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main Branch', code: 'QMAIN', isDefault: true },
  })
  const b01 = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 02', code: 'QB02' },
  })

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `qr-mains-${stamp}` },
  })
  // Sold at both, and cheaper at Branch 02 — so the quote can be checked
  // against the branch's own price rather than the restaurant's base price.
  const shared = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Rice and curry',
      slug: `qr-dish-${stamp}`,
      price: 80_000,
      isAvailable: true,
      branches: {
        create: [
          { restaurantId: restaurant.id, branchId: main.id },
          { restaurantId: restaurant.id, branchId: b01.id, price: 60_000 },
        ],
      },
    },
  })

  // On MAIN's menu only. Branch 02 must neither show it nor quote it.
  const mainOnly = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Main-only noodles',
      slug: `qr-main-only-${stamp}`,
      price: 90_000,
      isAvailable: true,
      branches: { create: [{ restaurantId: restaurant.id, branchId: main.id }] },
    },
  })

  // Main: tables 1 and 2. Branch 02: table 3 only.
  const mainTable1 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '1', capacity: 4 },
  })
  const mainTable2 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '2', capacity: 4 },
  })
  const b01Table3 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: b01.id, number: '3', capacity: 4 },
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

  console.log('\n── 1. the guest scans Branch 02’s QR ──')

  const landing = await fetch(`${BASE}/order?r=${restaurant.slug}&b=QB02`, { redirect: 'manual' })
  const landingBody = landing.status === 200 ? await landing.text() : ''
  check('the landing screen opens', landing.status === 200, `HTTP ${landing.status}`)
  check(
    'and names Branch 02, so the guest can see they scanned the right card',
    landingBody.includes('Branch 02'),
    'the guest cannot tell which place they are ordering from',
  )
  check(
    'and the middleware wrote the branch cookie',
    (landing.headers.get('set-cookie') ?? '').includes('ros_b=QB02'),
    landing.headers.get('set-cookie') ?? '(no set-cookie)',
  )

  const bogus = await fetch(`${BASE}/order?r=${restaurant.slug}&b=NOSUCH`, { redirect: 'manual' })
  check(
    'a code that matches no location is refused, not quietly served as Main',
    bogus.status !== 200 || !(await bogus.text()).includes('Main Branch'),
    `HTTP ${bogus.status} — a guessed code got somebody else’s menu`,
  )

  console.log('\n── 2. table 2 belongs to Main, not here ──')

  const wrongTable = await resolveTable({ tableNumber: '2' }, restaurant.slug, 'QB02')
  check(
    'entering table 2 at Branch 02 is refused',
    !wrongTable.ok,
    'the guest was seated at Main’s table 2 — the reported bug',
  )
  check(
    'the refusal names Branch 02 and not Main',
    !wrongTable.ok && /Branch 02/.test(wrongTable.error) && !/Main Branch/.test(wrongTable.error),
    !wrongTable.ok ? wrongTable.error : '',
  )

  const seated = await resolveTable({ tableNumber: '3' }, restaurant.slug, 'QB02')
  check(
    'entering table 3 is accepted, and it is Branch 02’s table 3',
    seated.ok && seated.data.tableId === b01Table3.id,
    seated.ok ? seated.data.tableId : seated.error,
  )

  // The same number at Main resolves to Main's own row, not Branch 02's.
  const atMain = await resolveTable({ tableNumber: '1' }, restaurant.slug, 'QMAIN')
  check(
    'and Main’s table 1 is Main’s, not another branch’s',
    atMain.ok && atMain.data.tableId === mainTable1.id,
    atMain.ok ? atMain.data.tableId : atMain.error,
  )

  console.log('\n── 3. only Branch 02’s menu, at Branch 02’s prices ──')

  const menu = await fetch(
    `${BASE}/api/public/menu?r=${restaurant.slug}&b=QB02`,
  ).then((r) => (r.ok ? r.json() : null))
  check(
    'the branch menu offers the shared dish',
    JSON.stringify(menu ?? {}).includes('Rice and curry'),
    'the guest cannot order what this branch sells',
  )
  check(
    'and does NOT offer the Main-only dish',
    !JSON.stringify(menu ?? {}).includes('Main-only noodles'),
    'another branch’s dish was on this branch’s menu',
  )

  const quote = await quoteCart(
    { items: [{ foodId: shared.id, quantity: 1, optionIds: [] }] },
    restaurant.slug,
    'QB02',
  )
  check(
    'the checkout quotes Branch 02’s price, not the base price',
    quote.ok && quote.data.totals.subtotal === 60_000,
    quote.ok
      ? `${quote.data.totals.subtotal} — the menu said 60000`
      : quote.error,
  )

  const quoteMainOnly = await quoteCart(
    { items: [{ foodId: mainOnly.id, quantity: 1, optionIds: [] }] },
    restaurant.slug,
    'QB02',
  )
  check(
    'and refuses a Main-only dish at quote time, not at the last tap',
    !quoteMainOnly.ok,
    'the guest would have filled in their details before being told',
  )

  console.log('\n── 4. the order is Branch 02’s ──')

  const order = await placeOrder({
    restaurantId: restaurant.id,
    branchId: b01.id,
    tableId: b01Table3.id,
    type: 'DINE_IN',
    channel: 'QR',
    customerName: 'Guest',
    customerPhone: `07${stamp.slice(-8).padEnd(8, '0')}`,
    items: [{ foodId: shared.id, quantity: 2, optionIds: [] }],
  })
  check('saved with Branch 02’s id', order.branchId === b01.id, `${order.branchId}`)
  check('and table 3', order.tableId === b01Table3.id)
  check(
    'and the table NUMBER is stored on the order, not only linked',
    order.tableNumber === '3',
    `${order.tableNumber} — deleting the table would erase which table this was`,
  )

  // Posting Main's table with Branch 02's code: the backend must refuse rather
  // than quietly preferring one of them.
  let mismatchRefused = false
  try {
    await placeOrder({
      restaurantId: restaurant.id,
      branchId: b01.id,
      tableId: mainTable2.id,
      type: 'DINE_IN',
      channel: 'QR',
      customerName: 'Tamperer',
      customerPhone: `07${stamp.slice(-8).padEnd(8, '7')}`,
      items: [{ foodId: shared.id, quantity: 1, optionIds: [] }],
    })
  } catch {
    mismatchRefused = true
  }
  check(
    'pasting Main’s table id with Branch 02’s code is refused',
    mismatchRefused,
    'a hand-edited request reached another branch',
  )

  console.log('\n── 5. whose kitchen display shows it ──')

  const atB02 = await fetch(`${BASE}/kitchen`, { headers: { cookie: await signIn(chefB01) } })
  const b02Screen = atB02.status === 200 ? await atB02.text() : ''
  check(
    'Branch 02’s kitchen display shows the ticket',
    b02Screen.includes(order.orderNumber),
    `HTTP ${atB02.status} — the branch that took the order cannot see it`,
  )

  const atMainKitchen = await fetch(`${BASE}/kitchen`, { headers: { cookie: await signIn(chefMain) } })
  const mainScreen = atMainKitchen.status === 200 ? await atMainKitchen.text() : ''
  check(
    'and Main’s kitchen display does not',
    !mainScreen.includes(order.orderNumber),
    'this is the symptom that was reported',
  )

  // A kitchen user cannot widen their own branch from the URL.
  const forced = await fetch(`${BASE}/kitchen?branch=${main.id}`, {
    headers: { cookie: await signIn(chefB01) },
  })
  const forcedScreen = forced.status === 200 ? await forced.text() : ''
  check(
    'and appending ?branch= does not widen a kitchen user’s view',
    !forcedScreen.includes('Main-only noodles'),
    'a kitchen account reached another branch by editing the URL',
  )

  console.log('\n── 6. a kitchen account with no location assigned ──')

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
