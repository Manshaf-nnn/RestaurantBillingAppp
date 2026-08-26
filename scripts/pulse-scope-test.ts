/**
 * The change detector has to detect the changes.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * `/api/pulse` returns a token that moves when something has happened, and
 * `<AutoRefresh>` re-renders only when it moves. That token was built from
 * orders, order items and service requests — and NOTHING else. So an owner
 * adding a dish to the menu changed nothing the token could see: every screen
 * in the building polled faithfully, correctly concluded that nothing had
 * happened, and went on showing the old menu until somebody reloaded the
 * browser. The till was the worst of it, because it renders the menu on the
 * server and had no `<AutoRefresh>` at all.
 *
 * ── Why scopes, and why that is the interesting half ────────────────────────
 *
 * One token watching everything would fix the menu and break the cost model:
 * a refresh re-renders the whole route, so a token that moved on every
 * order-item update would re-run every report page every ten seconds all day on
 * a per-invocation host. The last group of checks is therefore the point — a
 * scope has to move for what it watches AND stay still for what it does not.
 * Without that, "scoping" is just renaming.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/pulse-scope-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

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

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping.`)
    console.log('\n═══ 0 passed, 0 failed ═══\n')
    process.exit(0)
  }

  const stamp = Date.now().toString(36)

  const shop = await prisma.restaurant.create({
    data: { name: `Pulse ${stamp}`, slug: `pulse-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const owner = await prisma.user.create({
    data: {
      restaurantId: shop.id, name: 'Owner', email: `pulse-${stamp}@t.test`,
      passwordHash: 'x', role: 'OWNER', isActive: true, emailVerifiedAt: new Date(),
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: shop.id, name: 'Mains', slug: `mains-${stamp}` },
  })

  // A second tenant, to prove one restaurant's edits never wake another's screens.
  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const otherCategory = await prisma.category.create({
    data: { restaurantId: other.id, name: 'Mains', slug: `omains-${stamp}` },
  })

  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: owner.id, refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const access = await signAccessToken({
    sub: owner.id, rid: shop.id, role: owner.role, name: owner.name,
    email: owner.email, sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  const cookie = `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`

  const token = async (scope: string): Promise<string> => {
    const response = await fetch(`${BASE}/api/pulse?scope=${scope}`, {
      headers: { cookie },
      cache: 'no-store',
    })
    const body = (await response.json()) as { v: string | null }
    return body.v ?? ''
  }

  /** Did `scope`'s token move while `mutate` ran? */
  const moves = async (scope: string, mutate: () => Promise<unknown>): Promise<boolean> => {
    const before = await token(scope)
    await mutate()
    return (await token(scope)) !== before
  }

  console.log('\n── 1. A menu edit is noticed at all ────────────────────────')

  let food: { id: string } | null = null
  // THE HEADLINE. Fails against the old token, which could not see `foods`.
  check(
    'adding a dish moves the catalog token',
    await moves('catalog', async () => {
      food = await prisma.food.create({
        data: {
          restaurantId: shop.id, categoryId: category.id, name: `Rice ${stamp}`,
          slug: `rice-${stamp}`, price: 50_000, isAvailable: true,
        },
      })
    }),
  )

  check(
    'editing its price moves it',
    await moves('catalog', () =>
      prisma.food.update({ where: { id: food!.id }, data: { price: 60_000 } }),
    ),
  )

  check(
    'taking it off sale moves it',
    await moves('catalog', () =>
      prisma.food.update({ where: { id: food!.id }, data: { isAvailable: false } }),
    ),
  )

  // A DELETE moves no `updatedAt` anywhere, which is why the token carries
  // counts as well as timestamps.
  check(
    'DELETING it moves it',
    await moves('catalog', () => prisma.food.delete({ where: { id: food!.id } })),
  )

  console.log('\n── 2. The rest of the catalogue ────────────────────────────')

  check(
    'a new category moves it',
    await moves('catalog', () =>
      prisma.category.create({
        data: { restaurantId: shop.id, name: `Sides ${stamp}`, slug: `sides-${stamp}` },
      }),
    ),
  )

  check(
    'a new inventory item moves it',
    await moves('catalog', () =>
      prisma.inventoryItem.create({
        data: { restaurantId: shop.id, name: `Flour ${stamp}`, unit: 'KG', quantity: 0 },
      }),
    ),
  )

  console.log('\n── 3. The floor, for the live board ────────────────────────')

  const table = await prisma.restaurantTable.create({
    data: { restaurantId: shop.id, branchId: branch.id, number: '1', capacity: 4 },
  })

  check(
    'a table changing status moves the live token',
    await moves('live', () =>
      prisma.restaurantTable.update({ where: { id: table.id }, data: { status: 'CLEANING' } }),
    ),
  )

  console.log('\n── 4. One restaurant never wakes another ───────────────────')

  check(
    'another tenant’s new dish does not move ours',
    !(await moves('catalog', () =>
      prisma.food.create({
        data: {
          restaurantId: other.id, categoryId: otherCategory.id, name: 'Theirs',
          slug: `theirs-${stamp}`, price: 1000, isAvailable: true,
        },
      }),
    )),
  )

  console.log('\n── 5. And a scope stays still for what it does not watch ───')

  /*
   * The half that makes scoping worth having. If `catalog` moved on kitchen
   * traffic, every till in the building would re-render its whole route every
   * ten seconds during service — which is the cost this route exists to avoid.
   */
  const order = await prisma.order.create({
    data: {
      restaurantId: shop.id, branchId: branch.id, orderNumber: `P-${stamp}`,
      type: 'DINE_IN', channel: 'STAFF', status: 'PENDING',
      customerName: 'X', customerPhone: '', subtotal: 1000, grandTotal: 1000,
      placedAt: new Date(),
      items: { create: [{ name: 'Rice', unitPrice: 1000, quantity: 1, lineTotal: 1000 }] },
    },
    include: { items: true },
  })

  check(
    'an order-item change moves the ops token',
    await moves('ops', () =>
      prisma.orderItem.update({
        where: { id: order.items[0].id },
        data: { status: 'PREPARING' },
      }),
    ),
  )

  check(
    'and leaves the catalog token alone',
    !(await moves('catalog', () =>
      prisma.orderItem.update({
        where: { id: order.items[0].id },
        data: { status: 'READY' },
      }),
    )),
  )

  check(
    'a menu edit leaves the ops token alone',
    !(await moves('ops', () =>
      prisma.category.update({
        where: { id: category.id },
        data: { name: `Mains ${Date.now()}` },
      }),
    )),
  )

  console.log('\n── 6. A served-but-unpaid table is still live ──────────────')

  /*
   * `ops` stops at READY — right for a kitchen, which has no further interest.
   * `live` carries on to SERVED, because a table whose food is all out and
   * whose bill is unpaid is still sitting there, and the board raises a
   * payment-pending alert about exactly that.
   */
  await prisma.order.update({ where: { id: order.id }, data: { status: 'SERVED' } })
  check(
    'an item edit on a SERVED order still moves the live token',
    await moves('live', () =>
      prisma.orderItem.update({
        where: { id: order.items[0].id },
        data: { status: 'SERVED' },
      }),
    ),
  )

  console.log('\n── 7. An unknown scope is the safe one ─────────────────────')

  check('a nonsense scope falls back to ops rather than failing', (await token('wat')).length > 0)

  await prisma.orderItem.deleteMany({ where: { orderId: order.id } })
  await prisma.order.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.food.deleteMany({ where: { restaurantId: { in: [shop.id, other.id] } } })
  await prisma.category.deleteMany({ where: { restaurantId: { in: [shop.id, other.id] } } })
  await prisma.session.deleteMany({ where: { userId: owner.id } })
  await prisma.user.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.deleteMany({ where: { id: { in: [shop.id, other.id] } } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
