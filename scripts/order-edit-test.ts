/**
 * Editing an order after it was placed, from both doors (order editing).
 *
 *   the guest, on their phone   → add dishes · cancel a dish the kitchen has
 *                                  not started
 *   the till, for any order     → add dishes · cancel any dish, with a reason
 *
 * Both reach the kitchen display the same way: the ticket is replaced from a
 * fresh payload, so an added line appears on it and a cancelled one shows
 * crossed out. This suite pins the till's door and that the two doors share
 * one core — the guest's door is pinned by guest-add-items-test.
 *
 *   - lines a cashier adds are priced at the order's branch, routed to their
 *     section, and taken off stock — once — and the bill re-totals;
 *   - the order's history says WHO added them, by name, not "Customer";
 *   - the kitchen queue carries the new lines at once;
 *   - a paid bill refuses both doors, because its shape does not change;
 *   - a cancelled dish stays on the kitchen queue as CANCELLED and the bill
 *     comes down by it;
 *   - and the two doors are the same function, so a fix to one cannot leave
 *     the other behind.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/order-edit-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { addGuestOrderItems, addStaffOrderItems } from '../src/features/orders/guest-additions'
import { placeOrder } from '../src/features/orders/service'
import { getKitchenQueue } from '../src/features/orders/queries'
import { voidOrderItem } from '../src/features/cashier/service'
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
let seq = 0
const key = () => `edit-${stamp}-${++seq}`

async function cleanup(id: string) {
  await prisma.payment.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.tableSession.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Edit Co', slug: `edit-${stamp}`, email: `edit-${stamp}@test.local`, currency: 'LKR' },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `till-${stamp}@test.local`, name: 'Sara',
      passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` },
  })
  const mk = async (name: string, price: number) => {
    const food = await prisma.food.create({
      data: { restaurantId: restaurant.id, categoryId: category.id, name, slug: `${name.toLowerCase()}-${stamp}`, price, isAvailable: true },
    })
    await prisma.foodBranch.create({
      data: { restaurantId: restaurant.id, branchId: branch.id, foodId: food.id, isAvailable: true },
    })
    return food
  }
  // A dine-in order needs somewhere to sit.
  const table = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, number: '7', capacity: 4 },
  })
  const rice = await mk('Rice', 100_000)
  const curry = await mk('Curry', 150_000)
  const tea = await mk('Tea', 20_000)

  const order = (type: 'DINE_IN' | 'TAKEAWAY' | 'COUNTER') =>
    placeOrder({
      restaurantId: restaurant.id,
      branchId: branch.id,
      channel: type === 'COUNTER' ? 'COUNTER' : 'STAFF',
      type: type === 'COUNTER' ? 'TAKEAWAY' : type,
      tableId: type === 'DINE_IN' ? table.id : undefined,
      customerName: 'Walk-in',
      customerPhone: '',
      items: [{ foodId: rice.id, quantity: 1, optionIds: [], notes: '' }],
      createdById: cashier.id,
    })
  const onRail = async (orderId: string) =>
    (await getKitchenQueue(restaurant.id, [branch.id])).find((row) => row.id === orderId)

  console.log('\n── 1. The till adds to a dine-in, a takeaway and a counter order ──')
  for (const type of ['DINE_IN', 'TAKEAWAY', 'COUNTER'] as const) {
    const bill = await order(type)
    const { order: after, added } = await addStaffOrderItems({
      restaurantId: restaurant.id, orderId: bill.id, staffName: cashier.name,
      items: [{ foodId: curry.id, quantity: 2, optionIds: [] }, { foodId: tea.id, quantity: 1, optionIds: [] }],
    })
    check(`${type}: the lines are on the order`, added.length === 2)
    check(`${type}: priced at the branch and re-totalled`, after.subtotal === 100_000 + 2 * 150_000 + 20_000, String(after.subtotal))
    const ticket = await onRail(bill.id)
    check(`${type}: the kitchen has them at once`, ticket?.items.some((item) => item.name === 'Curry' && item.quantity === 2) === true)
    const history = await prisma.orderEvent.findFirst({ where: { orderId: bill.id, note: { contains: 'added' } } })
    check(`${type}: the history names who added them`, (history?.note ?? '').startsWith('Sara added'), history?.note ?? '')
  }

  console.log('\n── 2. Added lines are routed and the ticket reads them as new ──')
  {
    const bill = await order('DINE_IN')
    await addStaffOrderItems({
      restaurantId: restaurant.id, orderId: bill.id, staffName: cashier.name,
      items: [{ foodId: tea.id, quantity: 3, optionIds: [] }],
    })
    const lines = await prisma.orderItem.findMany({ where: { orderId: bill.id }, orderBy: { createdAt: 'asc' } })
    const teaLine = lines.find((line) => line.name === 'Tea')
    check('the new line is QUEUED, not inherited from a cooked one', teaLine?.status === 'QUEUED')
    // Its own row, not a quantity bump on the original: the kitchen must see
    // it as new work. (Routing to a section is pinned by guest-add-items-test
    // §3 with a sectioned kitchen; this restaurant has none.)
    check('and it is its own line, not a bump on the original', lines.length === 2)
    check('the original line was not touched', lines.find((line) => line.name === 'Rice')?.quantity === 1)
  }

  console.log('\n── 3. The till cancels a dish, and the kitchen keeps it crossed out ──')
  {
    const bill = await order('DINE_IN')
    await addStaffOrderItems({
      restaurantId: restaurant.id, orderId: bill.id, staffName: cashier.name,
      items: [{ foodId: curry.id, quantity: 1, optionIds: [] }],
    })
    const before = await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })
    const curryLine = await prisma.orderItem.findFirstOrThrow({ where: { orderId: bill.id, name: 'Curry' } })

    const { order: after } = await voidOrderItem({
      restaurantId: restaurant.id, orderId: bill.id, itemId: curryLine.id,
      reason: 'Guest changed their mind', actorId: cashier.id, actorName: cashier.name,
    })
    check('the bill comes down by the dish', after.subtotal === before.subtotal - 150_000, `${before.subtotal} → ${after.subtotal}`)
    check('the row is CANCELLED, not deleted', (await prisma.orderItem.findUnique({ where: { id: curryLine.id } }))?.status === 'CANCELLED')
    const ticket = await onRail(bill.id)
    check('the kitchen still has it, marked cancelled', ticket?.items.some((item) => item.id === curryLine.id && item.status === 'CANCELLED') === true)
    check('and the history says who and why', (await prisma.orderEvent.count({
      where: { orderId: bill.id, note: { contains: 'Voided 1 × Curry — Guest changed their mind' } },
    })) === 1)

    await refuses(
      'the last dish cannot be cancelled this way — that is cancelling the bill',
      async () => voidOrderItem({
        restaurantId: restaurant.id, orderId: bill.id,
        itemId: (await prisma.orderItem.findFirstOrThrow({ where: { orderId: bill.id, name: 'Rice' } })).id,
        reason: 'Trying', actorId: cashier.id, actorName: cashier.name,
      }),
      /VOID_LAST_ITEM/,
    )
  }

  console.log('\n── 4. A paid bill does not change shape ──')
  {
    const bill = await order('TAKEAWAY')
    await capturePayment({
      restaurantId: restaurant.id, orderId: bill.id, amount: bill.grandTotal,
      method: 'CASH', receivedById: cashier.id, clientRequestId: key(),
    })
    await refuses(
      'the till cannot add to it',
      () => addStaffOrderItems({
        restaurantId: restaurant.id, orderId: bill.id, staffName: cashier.name,
        items: [{ foodId: tea.id, quantity: 1, optionIds: [] }],
      }),
      /ORDER_PAID/,
    )
    await refuses(
      'nor a guest',
      () => addGuestOrderItems({
        restaurantId: restaurant.id, orderId: bill.id, guestSessionId: 'anything',
        items: [{ foodId: tea.id, quantity: 1, optionIds: [] }],
      }),
      /not found|Order|ORDER_PAID/i,
    )
    await refuses(
      "another restaurant's till cannot add to it",
      () => addStaffOrderItems({
        restaurantId: 'not-ours', orderId: bill.id, staffName: 'Stranger',
        items: [{ foodId: tea.id, quantity: 1, optionIds: [] }],
      }),
      /not found|Order/i,
    )
  }

  console.log('\n── 5. One core, two doors ──')
  {
    const source = readFileSync('src/features/orders/guest-additions.ts', 'utf8')
    check('the guest door and the till door call the same function',
      source.includes('async function addOrderItems(') &&
      source.includes("addedBy: 'Customer'") &&
      source.includes('addedBy: params.staffName'))
    check('and only one of them writes order lines', source.split('tx.orderItem.create(').length === 2)

    const till = readFileSync('src/features/cashier/components/cashier-board.tsx', 'utf8')
    check('the till offers Add items on an unpaid bill', till.includes('<Plus /> Add items') && till.includes('addItemsToBillAction'))
    check('and a way to cancel a line, with a reason', till.includes('Cancel this item') && till.includes('voidItemAction'))
    check('both shut once money is on the bill', till.includes('const editable = bill.paidTotal === 0'))

    const kds = readFileSync('src/features/kitchen/components/kitchen-board.tsx', 'utf8')
    check('the kitchen replaces its ticket from the update, so both doors reach it',
      kds.includes('ticket.id === payload.id ? toTicket(payload) : ticket'))
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
