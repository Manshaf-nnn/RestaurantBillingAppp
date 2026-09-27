/**
 * A delivery QR order is accepted on the till's Delivery tab.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * A guest's delivery order reached the Delivery tab, and its "Accept & send to
 * kitchen" button did nothing but say the order was "waiting for the cashier to
 * accept it". The button called the plain status change, which refuses a
 * pending guest order on purpose: a guest order has one way in, the till's
 * accept, because that is what routes each dish to its section and prints the
 * KOT. The Delivery tab is the till for deliveries, so it must use that door.
 *
 * Pinned here:
 *   - the plain status change still refuses (the gate is right, not the bug);
 *   - the till's accept takes the SAME pending delivery into the kitchen;
 *   - the Delivery tab's button calls the till's accept for a PENDING order;
 *   - the cashier's own "waiting for acceptance" list leaves deliveries out,
 *     so exactly one screen owns the decision.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/delivery-accept-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { acceptGuestOrder } from '../src/features/cashier/service'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.notification.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `Deliver ${stamp}`, slug: `deliver-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true } })
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const kottu = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Kottu', slug: `kottu-${stamp}`, price: 90_000, isAvailable: true },
  })
  await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: kottu.id, branchId: branch.id, isAvailable: true } })
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `deliver-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: branch.id },
  })
  const actor = { actorId: cashier.id, actorName: cashier.name }

  console.log('\n── 1. A guest orders a delivery by QR ──')
  const order = await placeOrder({
    restaurantId: restaurant.id, branchId: branch.id, tableId: null,
    type: 'DELIVERY', channel: 'QR', customerName: 'Nila', customerPhone: '0771234567',
    items: [{ foodId: kottu.id, quantity: 2, optionIds: [] }],
  })
  check('it arrives pending, waiting for a yes', order.status === 'PENDING', order.status)

  console.log('\n── 2. What the Delivery tab used to do ──')
  try {
    await updateOrderStatus({ restaurantId: restaurant.id, orderId: order.id, status: 'ACCEPTED', ...actor })
    check('the plain status change refuses a pending guest order', false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(
      'the plain status change refuses it, with the message the owner saw',
      /waiting for the cashier to accept/i.test(message),
      message,
    )
  }

  console.log('\n── 3. What it does now: the till’s accept ──')
  const { order: accepted } = await acceptGuestOrder({ restaurantId: restaurant.id, orderId: order.id, ...actor })
  check('the same order is now with the kitchen', accepted.status === 'ACCEPTED' && accepted.id === order.id, accepted.status)
  const event = await prisma.orderEvent.findFirst({ where: { orderId: order.id, status: 'ACCEPTED' } })
  check('the acceptance is on the order’s own history', Boolean(event))

  console.log('\n── 4. The screens are wired that way ──')
  const board = readFileSync('src/features/cashier/components/delivery-board.tsx', 'utf8')
  check('the Delivery tab calls the till’s accept for a pending order', /order\.status === 'PENDING'\s*\?\s*acceptGuestOrderAction/.test(board))
  check('and hides the button from someone without the accept permission', board.includes('canAccept'))
  const pos = readFileSync('src/app/cashier/pos/page.tsx', 'utf8')
  check('the till passes that permission to the Delivery tab', /<DeliveryBoard[\s\S]{0,200}canAccept=\{can\(user, PERMISSIONS\.ORDER_ACCEPT\)\}/.test(pos))
  const cashierBoard = readFileSync('src/features/cashier/components/cashier-board.tsx', 'utf8')
  check('the cashier’s accept list leaves deliveries to the Delivery tab', /awaitsCashier\(bill\) && bill\.type !== 'DELIVERY'/.test(cashierBoard))
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
