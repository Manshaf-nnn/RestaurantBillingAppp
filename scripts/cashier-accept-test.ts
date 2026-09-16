/**
 * QR and online orders wait for the cashier (abc.md §5).
 *
 *   - a guest order (QR / ONLINE) is PENDING at the till: the kitchen rail,
 *     the kitchen's counts and the waiter's "being cooked" list leave it out,
 *     the cashier queue has it;
 *   - nobody but the till can move it on: PENDING → PREPARING is refused for
 *     a guest order, and so is PENDING → ACCEPTED without the cashier's gate;
 *     a staff order goes straight to the kitchen as before;
 *   - Accept at the till runs the ordinary ACCEPTED transition on the SAME
 *     order (routing, stock, notifications), after which the kitchen sees it;
 *     accepting twice, or accepting a staff order there, is refused;
 *   - Reject needs a reason and is a cancellation: reason stored, table freed;
 *   - placing a guest order tells the cashier and management, not the kitchen;
 *     a staff order tells the kitchen as before;
 *   - the action is gated on order.accept (split from payment.collect, held by
 *     cashiers), branch-checked and audited; the KDS ignores a pending guest
 *     order arriving live and shows it once accepted.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/cashier-accept-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { acceptGuestOrder, rejectGuestOrder } from '../src/features/cashier/service'
import { getCashierQueue, getKitchenQueue, getKitchenStats, getWaiterBoard } from '../src/features/orders/queries'
import { awaitsCashier, isGuestChannel } from '../src/features/orders/channels'

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
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.tableSession.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  console.log('\n── 0. Which orders wait ──')
  {
    check('QR and online are guest channels', isGuestChannel('QR') && isGuestChannel('ONLINE'))
    check('staff, counter and phone are not', !isGuestChannel('STAFF') && !isGuestChannel('COUNTER') && !isGuestChannel('PHONE'))
    check('a pending guest order awaits the cashier', awaitsCashier({ status: 'PENDING', channel: 'QR' }))
    check('an accepted one, or a staff one, does not', !awaitsCashier({ status: 'ACCEPTED', channel: 'QR' }) && !awaitsCashier({ status: 'PENDING', channel: 'STAFF' }))
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Till ${stamp}`, slug: `till-${stamp}`, status: 'ACTIVE', isActive: true,
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
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 50_000, isAvailable: true },
  })
  await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: rice.id, branchId: branch.id, isAvailable: true } })
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `till-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: branch.id },
  })
  const actor = { actorId: cashier.id, actorName: cashier.name }

  const order = (tableId: string, channel: 'QR' | 'ONLINE' | 'STAFF', name: string) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId, type: 'DINE_IN', channel,
      items: [{ foodId: rice.id, quantity: 2, optionIds: [] }],
      customerName: name, customerPhone: '0770000000',
    })
  const step = (orderId: string, status: 'ACCEPTED' | 'PREPARING', gate?: 'cashier') =>
    updateOrderStatus({ restaurantId: restaurant.id, orderId, status, gate, ...actor })
  const kitchenHas = async (orderId: string) =>
    (await getKitchenQueue(restaurant.id, [branch.id])).some((row) => row.id === orderId)

  console.log('\n── 1. A guest order is the till’s until the till says otherwise ──')
  const qr = await order(t1.id, 'QR', 'Scanner')
  const staff = await order(t2.id, 'STAFF', 'Walk-in')
  {
    check('placed pending, from the QR channel', qr.status === 'PENDING' && qr.channel === 'QR')
    await refuses('the kitchen cannot start cooking it', () => step(qr.id, 'PREPARING'), /CASHIER_ACCEPT_REQUIRED/)
    await refuses('nor take it on without the till’s gate', () => step(qr.id, 'ACCEPTED'), /CASHIER_ACCEPT_REQUIRED/)
    check('it is still pending', (await prisma.order.findUniqueOrThrow({ where: { id: qr.id } })).status === 'PENDING')
    const cooked = await step(staff.id, 'PREPARING')
    check('a staff order goes straight to the kitchen as before', cooked.status === 'PREPARING')
  }

  console.log('\n── 2. Where a pending guest order shows, and where it does not ──')
  {
    check('not on the kitchen rail', !(await kitchenHas(qr.id)))
    check('the staff order is', await kitchenHas(staff.id))
    const stats = await getKitchenStats(restaurant.id, [branch.id])
    check('not in the kitchen’s pending count', stats.pending === 0, `${stats.pending}`)
    const board = await getWaiterBoard(restaurant.id, [branch.id])
    check('not on the waiter’s "being cooked" list', !board.serving.some((row) => row.id === qr.id) && board.serving.some((row) => row.id === staff.id))
    const till = await getCashierQueue(restaurant.id, [branch.id])
    check('on the cashier queue, awaiting acceptance', till.some((row) => row.id === qr.id && awaitsCashier(row)))
  }

  console.log('\n── 3. Accept at the till ──')
  {
    await refuses('a staff order is not the till’s to accept', () => acceptGuestOrder({ restaurantId: restaurant.id, orderId: staff.id, ...actor }), /NOT_GUEST_ORDER/)
    const accepted = await acceptGuestOrder({ restaurantId: restaurant.id, orderId: qr.id, ...actor })
    check('the same order is now Accepted, stamped', accepted.order.id === qr.id && accepted.order.status === 'ACCEPTED' && accepted.order.acceptedAt !== null)
    check('and the kitchen sees it', await kitchenHas(qr.id))
    const event = await prisma.orderEvent.findFirst({ where: { orderId: qr.id, status: 'ACCEPTED' } })
    check('with the cashier on the event', event?.actorId === cashier.id)
    await refuses('accepting it again is refused', () => acceptGuestOrder({ restaurantId: restaurant.id, orderId: qr.id, ...actor }), /ORDER_ALREADY_ACCEPTED/)
    const cooked = await step(qr.id, 'PREPARING')
    check('from here the kitchen drives it as any other order', cooked.status === 'PREPARING')
  }

  console.log('\n── 4. Reject at the till is a cancellation, with a reason ──')
  {
    const online = await order(t3.id, 'ONLINE', 'Website')
    check('the table is occupied by the online order', (await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t3.id } })).status === 'OCCUPIED')
    await refuses('no reason, no rejection', () => rejectGuestOrder({ restaurantId: restaurant.id, orderId: online.id, reason: ' ', ...actor }), /REJECT_NO_REASON/)
    await refuses('a staff order is not rejected here', () => rejectGuestOrder({ restaurantId: restaurant.id, orderId: staff.id, reason: 'Closing', ...actor }), /NOT_GUEST_ORDER/)
    const rejected = await rejectGuestOrder({ restaurantId: restaurant.id, orderId: online.id, reason: 'Kitchen closing', ...actor })
    check('cancelled, reason kept', rejected.status === 'CANCELLED' && rejected.cancelReason === 'Kitchen closing')
    check('the table is Empty again', (await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t3.id } })).status === 'AVAILABLE')
    await refuses('an accepted order cannot be rejected at the till', () => rejectGuestOrder({ restaurantId: restaurant.id, orderId: qr.id, reason: 'Too late', ...actor }), /ORDER_ALREADY_ACCEPTED/)
  }

  console.log('\n── 5. Who is told when an order arrives ──')
  {
    const placedFor = async (orderId: string) =>
      (await prisma.notification.findMany({ where: { restaurantId: restaurant.id, type: 'ORDER_PLACED' } }))
        .filter((row) => (row.data as { orderId?: string } | null)?.orderId === orderId)
    const forQr = await placedFor(qr.id)
    check('a guest order tells the cashier and management', forQr.some((n) => n.audience === 'CASHIER') && forQr.some((n) => n.audience === 'MANAGEMENT'))
    check('not the kitchen', !forQr.some((n) => n.audience === 'KITCHEN'))
    check('at the order’s own branch', forQr.every((n) => n.branchId === branch.id))
    const forStaff = await placedFor(staff.id)
    check('a staff order still tells the kitchen', forStaff.some((n) => n.audience === 'KITCHEN') && !forStaff.some((n) => n.audience === 'CASHIER'))
  }

  console.log('\n── 6. The action, the permission, the boards ──')
  {
    const actions = readFileSync('src/features/cashier/actions.ts', 'utf8')
    const accept = actions.slice(actions.indexOf('export async function acceptGuestOrderAction'), actions.indexOf('export async function rejectGuestOrderAction'))
    const reject = actions.slice(actions.indexOf('export async function rejectGuestOrderAction'))
    check('accept and reject are gated on order.accept', accept.includes('PERMISSIONS.ORDER_ACCEPT') && reject.includes('PERMISSIONS.ORDER_ACCEPT'))
    check("scoped to the bill's site", accept.includes('assertBillBranch(') && reject.includes('assertBillBranch('))
    check('both audited', accept.includes('AUDIT_ACTIONS.ORDER_ACCEPTED_AT_TILL') && reject.includes('AUDIT_ACTIONS.ORDER_CANCELLED'))

    const rbac = readFileSync('src/lib/rbac.ts', 'utf8')
    const cashierBlock = rbac.slice(rbac.indexOf('const CASHIER'), rbac.indexOf('const WAITER'))
    check('cashiers hold it; anyone who collects payment gets it by the split', cashierBlock.includes('PERMISSIONS.ORDER_ACCEPT') && rbac.includes('[PERMISSIONS.ORDER_ACCEPT, PERMISSIONS.PAYMENT_COLLECT]'))
    const features = readFileSync('src/features/access/features.ts', 'utf8')
    check('and the payments feature sells it', /key: 'payments'[\s\S]*?PERMISSIONS\.ORDER_ACCEPT/.test(features))

    const kds = readFileSync('src/features/kitchen/components/kitchen-board.tsx', 'utf8')
    check('the KDS ignores a pending guest order arriving live', kds.includes('awaitsCashier(payload)'))
    const board = readFileSync('src/features/cashier/components/cashier-board.tsx', 'utf8')
    check('the till has a "Waiting for acceptance" section', board.includes('Waiting for acceptance') && board.includes('acceptGuestOrderAction') && board.includes('rejectGuestOrderAction'))
    const service = readFileSync('src/features/orders/service.ts', 'utf8')
    check('the gate is in the service, not only the screen', service.includes("params.gate !== 'cashier'") && service.includes("'CASHIER_ACCEPT_REQUIRED'"))
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
