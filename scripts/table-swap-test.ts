/**
 * A sitting moves to an empty table (abc.md §3).
 *
 *   - the open sitting and every open order re-point at the target; items,
 *     payments, customer and totals are untouched; each moved order records
 *     where it came from; the target is Occupied and the source Empty;
 *   - the target must be at the same site, in service, and free: no open
 *     sitting or order, not held by a booking in its window, not marked
 *     Occupied; the source must have something to move; same table refused;
 *   - the sitting's unique `activeTableKey` still holds afterwards;
 *   - the action audits the move and broadcasts both tables and every moved
 *     order (pinned from its source).
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/table-swap-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { swapTable } from '../src/features/floor/service'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
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
const MIN = 60_000
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.payment.deleteMany({ where: { restaurantId: id } })
  await prisma.invoice.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.tableSession.deleteMany({ where: { restaurantId: id } })
  await prisma.reservation.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Swap ${stamp}`, slug: `swap-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const main_ = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Other', code: 'OTH' },
  })
  const mk = (number: string, branchId = main_.id, extra: { isActive?: boolean; status?: 'OCCUPIED' } = {}) =>
    prisma.restaurantTable.create({ data: { restaurantId: restaurant.id, branchId, number, capacity: 4, ...extra } })
  const t1 = await mk('1')
  const t2 = await mk('2')
  const t3 = await mk('3')
  const t4 = await mk('4', main_.id, { isActive: false })
  const t5 = await mk('5')
  const t6 = await mk('6', other.id)
  const t7 = await mk('7', main_.id, { status: 'OCCUPIED' })
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 50_000, isAvailable: true },
  })
  await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: rice.id, branchId: main_.id, isAvailable: true } })
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `swap-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: main_.id },
  })
  const order = (tableId: string, name: string) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: main_.id, tableId, type: 'DINE_IN',
      items: [{ foodId: rice.id, quantity: 2, optionIds: [] }],
      customerName: name, customerPhone: '0770000000',
    })
  const table = (id: string) => prisma.restaurantTable.findUniqueOrThrow({ where: { id } })

  // Table 1: a party with two orders, one already accepted, one partly paid.
  const a = await order(t1.id, 'Perera')
  const b = await order(t1.id, 'Perera')
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: a.id, status: 'ACCEPTED', actorId: null, actorName: null })
  await capturePayment({ restaurantId: restaurant.id, orderId: a.id, method: 'CASH', amount: 20_000, tenderedAmount: 20_000, receivedById: cashier.id })
  const sitting = await prisma.tableSession.findFirstOrThrow({ where: { tableId: t1.id, status: 'OPEN' } })
  // Table 3: somebody else. Table 5: booked, window open.
  await order(t3.id, 'Silva')
  await prisma.reservation.create({
    data: {
      restaurantId: restaurant.id, branchId: main_.id, tableId: t5.id, customerName: 'Booked', customerPhone: '0771111111',
      partySize: 2, reservedAt: new Date(Date.now() + 5 * MIN), durationMinutes: 90, status: 'CONFIRMED',
    },
  })

  const swap = (from: string, to: string) =>
    swapTable({ restaurantId: restaurant.id, fromTableId: from, toTableId: to, actorId: cashier.id, actorName: cashier.name })

  console.log('\n── 1. Refusals ──')
  {
    await refuses('the same table', () => swap(t1.id, t1.id), /TABLE_SWAP_SAME/)
    await refuses('an occupied target', () => swap(t1.id, t3.id), /TABLE_SWAP_TARGET_OCCUPIED/)
    await refuses('a target marked occupied by hand, even with no order', () => swap(t1.id, t7.id), /TABLE_SWAP_TARGET_OCCUPIED/)
    await refuses('a target out of service', () => swap(t1.id, t4.id), /TABLE_SWAP_TARGET_INACTIVE/)
    await refuses("a target reserved for somebody's booking", () => swap(t1.id, t5.id), /TABLE_SWAP_TARGET_RESERVED/)
    await refuses('a target at another site', () => swap(t1.id, t6.id), /TABLE_SWAP_BRANCH/)
    await refuses('a source with nothing open', () => swap(t2.id, t1.id), /TABLE_SWAP_TARGET_OCCUPIED|TABLE_SWAP_NOTHING_OPEN/)
    check('nothing moved on a refusal', (await table(t1.id)).status === 'OCCUPIED' && (await table(t2.id)).status === 'AVAILABLE')
  }

  console.log('\n── 2. The sitting moves, whole ──')
  {
    const before = {
      payments: await prisma.payment.count({ where: { orderId: a.id } }),
      items: await prisma.orderItem.count({ where: { orderId: { in: [a.id, b.id] } } }),
      paid: (await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).paidTotal,
    }
    const result = await swap(t1.id, t2.id)
    check('both open orders moved', result.movedOrderIds.length === 2 && result.movedOrderIds.includes(a.id) && result.movedOrderIds.includes(b.id))
    check('and the sitting with them', result.sessionId === sitting.id)

    const movedSitting = await prisma.tableSession.findUniqueOrThrow({ where: { id: sitting.id } })
    check('the sitting is at the new table, still open, holding its key', movedSitting.tableId === t2.id && movedSitting.status === 'OPEN' && movedSitting.activeTableKey === t2.id)
    const [aAfter, bAfter] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: a.id } }),
      prisma.order.findUniqueOrThrow({ where: { id: b.id } }),
    ])
    check('the orders point at the new table, snapshot number included', aAfter.tableId === t2.id && bAfter.tableId === t2.id && aAfter.tableNumber === '2')
    check('their status, customer and money are untouched', aAfter.status === 'ACCEPTED' && aAfter.customerName === 'Perera' && aAfter.paidTotal === before.paid && aAfter.paymentStatus === 'PARTIAL')
    check('payments and items are where they were', (await prisma.payment.count({ where: { orderId: a.id } })) === before.payments && (await prisma.orderItem.count({ where: { orderId: { in: [a.id, b.id] } } })) === before.items)
    const events = await prisma.orderEvent.findMany({ where: { orderId: { in: [a.id, b.id] }, note: { contains: 'Moved from table 1 to table 2' } } })
    check('each moved order says where it came from', events.length === 2 && events.every((e) => e.actorName === cashier.name))
    check('the source is Empty', (await table(t1.id)).status === 'AVAILABLE')
    check('the target is Occupied', (await table(t2.id)).status === 'OCCUPIED')
    check('one open sitting per table still holds', (await prisma.tableSession.count({ where: { restaurantId: restaurant.id, activeTableKey: t2.id } })) === 1)

    const again = await swap(t2.id, t1.id)
    check('and it moves back just as whole', again.movedOrderIds.length === 2 && (await table(t1.id)).status === 'OCCUPIED')
  }

  console.log('\n── 3. The action: guard, audit, news ──')
  {
    const actions = readFileSync('src/features/floor/actions.ts', 'utf8')
    const action = actions.slice(actions.indexOf('export async function swapTableAction'), actions.indexOf('// ── reservations'))
    check('gated on table.swap', action.includes('PERMISSIONS.TABLE_SWAP'))
    check("scoped to the source table's site", action.includes("assertRecordBranch(user, source, 'table')"))
    check('audited under its own key', action.includes('AUDIT_ACTIONS.TABLE_SWAPPED'))
    check('both tables announced', (action.match(/realtime\.tableUpdated\(/g) ?? []).length === 2)
    check('and every moved order', action.includes('realtime.orderUpdated(user.restaurantId, payload)'))
    const rbac = readFileSync('src/lib/rbac.ts', 'utf8')
    // The array is `const POS` since staff.A.md §10 renamed the role; the
    // block still ends where WAITER's begins.
    const cashierBlock = rbac.slice(rbac.indexOf('const POS'), rbac.indexOf('const WAITER'))
    check('POS holds it by default, and so does anyone who manages tables',
      cashierBlock.includes('PERMISSIONS.TABLE_SWAP') && rbac.includes('[PERMISSIONS.TABLE_SWAP, PERMISSIONS.TABLE_MANAGE]'))
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
