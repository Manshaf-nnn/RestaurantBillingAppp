/**
 * A guest adds NEW dishes from the menu to the order they already have
 * (aO.md §3).
 *
 *   - the lines are priced at the order's own branch, exactly as at placement,
 *     and written QUEUED; the bill is re-derived from every live line; the
 *     order's history says what was added;
 *   - on an order still waiting at the till, nothing is routed or taken off
 *     stock — the cashier's Accept does that for every line at once;
 *   - on an order the kitchen already has, the new lines are routed to their
 *     sections and their ingredients leave stock once; a dish with no section
 *     is refused with nothing written;
 *   - only the guest's own session may add; a served or paid order refuses;
 *   - the screens: the tracker links into the menu in "add to order" mode,
 *     the checkout sends the addition through this door, rate-limited.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/guest-add-items-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { addGuestOrderItems } from '../src/features/orders/guest-additions'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { acceptGuestOrder } from '../src/features/cashier/service'
import { capturePayment } from '../src/features/payments/service'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(`${code} ${message}`), `wrong reason: ${code} ${message}`)
  }
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.notification.deleteMany({ where: { restaurantId: id } })
  await prisma.payment.deleteMany({ where: { restaurantId: id } })
  await prisma.invoice.deleteMany({ where: { restaurantId: id } })
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.tableSession.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.kitchenStation.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryStock.deleteMany({ where: { item: { restaurantId: id } } }).catch(() => {})
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Add ${stamp}`, slug: `add-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const mk = (number: string) =>
    prisma.restaurantTable.create({ data: { restaurantId: restaurant.id, branchId: branch.id, number, capacity: 4 } })
  const t1 = await mk('1')
  const t2 = await mk('2')
  const t3 = await mk('3')
  const t4 = await mk('4')
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `add-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: branch.id },
  })
  const actor = { actorId: cashier.id, actorName: cashier.name }

  // A patty in stock, and a rice dish that uses one per plate.
  const patty = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Patty ${stamp}`, unit: 'PIECE', quantity: 0, costPerUnit: 0 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, { restaurantId: restaurant.id, itemId: patty.id, type: 'PURCHASE', quantity: 100, unitCost: 250, branchId: branch.id, userId: cashier.id }),
  )
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const food = async (name: string, price: number, branchPrice?: number) => {
    const row = await prisma.food.create({
      data: { restaurantId: restaurant.id, categoryId: category.id, name, slug: `${name.toLowerCase()}-${stamp}`, price, isAvailable: true },
    })
    await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: row.id, branchId: branch.id, isAvailable: true, price: branchPrice ?? null } })
    return row
  }
  const rice = await food('Rice', 50_000)
  const naan = await food('Naan', 40_000, 30_000)
  const recipe = await prisma.recipe.create({
    data: { restaurantId: restaurant.id, foodId: rice.id, yieldQty: 1, isActive: true, version: 1 },
  })
  await prisma.recipeIngredient.create({ data: { recipeId: recipe.id, inventoryItemId: patty.id, quantity: 1, unit: 'PIECE' } })

  const ALICE = `alice-${stamp}`
  const BOB = `bob-${stamp}`
  const qrOrder = (tableId: string, guestSessionId: string) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId, type: 'DINE_IN', channel: 'QR', guestSessionId,
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      customerName: 'Guest', customerPhone: '',
    })
  const add = (orderId: string, guestSessionId: string | null, items: Array<{ foodId: string; quantity: number }>) =>
    addGuestOrderItems({ restaurantId: restaurant.id, orderId, guestSessionId, items: items.map((i) => ({ ...i, optionIds: [] })) })
  const lines = (orderId: string) => prisma.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
  const pattyOnHand = async () => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: patty.id } })).quantity

  console.log('\n── 1. Adding to an order still waiting at the till ──')
  const waiting = await qrOrder(t1.id, ALICE)
  {
    const result = await add(waiting.id, ALICE, [{ foodId: naan.id, quantity: 2 }])
    check('the addition is one new line', result.added.length === 1 && result.added[0].name === 'Naan' && result.added[0].quantity === 2)
    const all = await lines(waiting.id)
    const added = all.find((l) => l.foodId === naan.id)!
    check('written QUEUED, priced at the branch price', added.status === 'QUEUED' && added.unitPrice === 30_000 && added.lineTotal === 60_000)
    check('not routed — the till has not accepted the order', added.routedAt === null && added.stationId === null)
    check('the bill is the sum of every live line', result.order.subtotal === all.reduce((s, l) => s + l.lineTotal, 0) && result.order.grandTotal >= result.order.subtotal)
    check('the estimate covers the new lines too', result.order.estimatedMinutes >= waiting.estimatedMinutes)
    check('nothing left stock yet', (await pattyOnHand()) === 100 && (await prisma.orderStockDepletion.count({ where: { orderId: waiting.id } })) === 0)
    const event = await prisma.orderEvent.findFirst({ where: { orderId: waiting.id, note: { contains: 'Customer added' } } })
    check('the history says what was added', event?.note === 'Customer added 2 × Naan')
    check('the order is still pending at the till', result.order.status === 'PENDING')
  }

  console.log('\n── 2. Adding to an order the kitchen already has ──')
  const cooking = await qrOrder(t2.id, ALICE)
  {
    await acceptGuestOrder({ restaurantId: restaurant.id, orderId: cooking.id, ...actor })
    check('acceptance took one patty for the rice', (await pattyOnHand()) === 99)
    await updateOrderStatus({ restaurantId: restaurant.id, orderId: cooking.id, status: 'PREPARING', ...actor })
    const result = await add(cooking.id, ALICE, [{ foodId: rice.id, quantity: 2 }])
    check('the addition joins a cooking order', result.added.length === 1 && result.order.status === 'PREPARING')
    check('and its ingredients leave stock once — two more patties', (await pattyOnHand()) === 97, `${await pattyOnHand()}`)
    const again = await add(cooking.id, ALICE, [{ foodId: naan.id, quantity: 1 }])
    check('a dish with no recipe adds without touching stock', again.added.length === 1 && (await pattyOnHand()) === 97)
    const all = await lines(cooking.id)
    check('every line is on the bill', all.length === 3 && result.order.subtotal < again.order.subtotal)
    const original = all[0]
    check('the original line is untouched', original.foodId === rice.id && original.quantity === 1 && original.status === 'PREPARING')
  }

  console.log('\n── 3. Kitchen sections: routed at once, or refused ──')
  const routed = await qrOrder(t3.id, BOB)
  {
    const station = await prisma.kitchenStation.create({
      data: { restaurantId: restaurant.id, branchId: branch.id, name: 'Tandoor' },
    })
    await prisma.foodBranch.update({ where: { foodId_branchId: { foodId: naan.id, branchId: branch.id } }, data: { stationId: station.id } })
    await prisma.foodBranch.update({ where: { foodId_branchId: { foodId: rice.id, branchId: branch.id } }, data: { stationId: station.id } })
    await acceptGuestOrder({ restaurantId: restaurant.id, orderId: routed.id, ...actor })
    const result = await add(routed.id, BOB, [{ foodId: naan.id, quantity: 1 }])
    const added = (await lines(routed.id)).find((l) => l.foodId === naan.id)!
    check('a new line on an accepted order is sent to its section at once', result.added.length === 1 && added.stationId === station.id && added.routedAt !== null)

    // A dish with no section cannot be added to a kitchen that uses sections.
    const stranded = await food('Soup', 20_000)
    const before = (await lines(routed.id)).length
    await refuses('a dish with no section is refused', () => add(routed.id, BOB, [{ foodId: stranded.id, quantity: 1 }]), /ITEM_NO_STATION/)
    check('and nothing was written', (await lines(routed.id)).length === before)
  }

  console.log('\n── 4. Whose order, and when it is too late ──')
  {
    await refuses("another guest's session cannot add", () => add(waiting.id, BOB, [{ foodId: naan.id, quantity: 1 }]), /not found/i)
    await refuses('no session, nothing to add to', () => add(waiting.id, null, [{ foodId: naan.id, quantity: 1 }]), /not found/i)
    await refuses('nothing chosen is refused', () => add(waiting.id, ALICE, []), /EMPTY_ADDITION/)

    const paid = await qrOrder(t4.id, ALICE)
    await acceptGuestOrder({ restaurantId: restaurant.id, orderId: paid.id, ...actor })
    await capturePayment({ restaurantId: restaurant.id, orderId: paid.id, method: 'CASH', amount: paid.grandTotal, tenderedAmount: paid.grandTotal, receivedById: cashier.id })
    await refuses('a paid bill refuses', () => add(paid.id, ALICE, [{ foodId: naan.id, quantity: 1 }]), /ORDER_PAID/)

    for (const status of ['PREPARING', 'READY', 'SERVED'] as const) {
      await updateOrderStatus({ restaurantId: restaurant.id, orderId: cooking.id, status, ...actor })
    }
    await refuses('a served order refuses', () => add(cooking.id, ALICE, [{ foodId: naan.id, quantity: 1 }]), /ORDER_LOCKED/)
  }

  console.log('\n── 5. The screens ──')
  {
    const actions = readFileSync('src/features/orders/actions.ts', 'utf8')
    const action = actions.slice(actions.indexOf('export async function addGuestOrderItems'))
    check('the action goes through this door, rate-limited, as the guest’s own session', action.includes('addGuestOrderItemsService(') && action.includes("enforceRateLimit('placeOrder'") && action.includes('getOrCreateGuestSessionId()'))
    const checkout = readFileSync('src/features/orders/components/cart-checkout.tsx', 'utf8')
    check('the checkout sends an addition through it', checkout.includes('addGuestOrderItems({') && checkout.includes('addingTo'))
    const menu = readFileSync('src/features/orders/components/menu-browser.tsx', 'utf8')
    check('the menu says which order is being added to', menu.includes('Adding to order'))
    const tracker = readFileSync('src/features/orders/components/order-tracker.tsx', 'utf8')
    check('the tracker links into the menu in add mode', tracker.includes('?add=${initial.id}'))
  }
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
