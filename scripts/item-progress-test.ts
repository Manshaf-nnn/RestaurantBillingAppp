/**
 * Item-level kitchen progress, by quantity (abc.md §6).
 *
 *   - a line keeps one status and gains `preparedQty` / `servedQty`; the
 *     status is a readout of the counters (served all → SERVED, prepared all
 *     → READY, some prepared → PREPARING);
 *   - counters only go up; nothing over the quantity; nothing served that is
 *     not prepared; a PENDING, cancelled or completed order refuses; so does a
 *     cancelled line;
 *   - the order follows its lines (PREPARING / READY / SERVED) and stamps
 *     `readyAt` when the last plate is made;
 *   - the order-level cascades (an unrouted READY, any SERVED) carry the
 *     counters with them, so a cascaded line never reads "0 of 3";
 *   - a split keeps the made plates with the original, first, and both rows
 *     satisfy the database's rule; a merge carries the counters across;
 *   - the live floor reads Ordered / Prepared / Served / Remaining by
 *     quantity, exactly as the spec's three examples say, and never counts
 *     Served as Prepared;
 *   - the action is gated, branch-checked and audited; the boards and the
 *     guest tracker listen to the line event.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/item-progress-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import {
  applyProgress,
  progressLabel,
  rowStatusFromCounters,
  summariseProgress,
} from '../src/features/orders/progress'
import { cancelOrder, placeOrder, progressItems, updateOrderStatus } from '../src/features/orders/service'
import { mergeBills, splitBill } from '../src/features/cashier/service'
import { getLiveBoard } from '../src/features/live/queries'

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
  console.log('\n── 1. The arithmetic, pure ──')
  {
    const row = (
      quantity: number, preparedQty: number, servedQty: number,
      status: 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED' = 'QUEUED',
    ) => ({ quantity, preparedQty, servedQty, status })
    check('nothing made yet reads as it was', rowStatusFromCounters(row(3, 0, 0)) === 'QUEUED')
    check('one of three made reads Preparing', rowStatusFromCounters(row(3, 1, 0)) === 'PREPARING')
    check('all made reads Ready', rowStatusFromCounters(row(3, 3, 0)) === 'READY')
    check('all made and one served still reads Ready', rowStatusFromCounters(row(3, 3, 1)) === 'READY')
    check('all served reads Served', rowStatusFromCounters(row(3, 3, 3)) === 'SERVED')
    check('a cancelled line stays cancelled', rowStatusFromCounters({ ...row(3, 3, 3), status: 'CANCELLED' as never }) === 'CANCELLED')

    const backwards = applyProgress({ ...row(3, 2, 1), name: 'Burger' }, { preparedQty: 1 })
    check('going backwards is refused', !backwards.ok && backwards.refusal.code === 'PROGRESS_BACKWARDS')
    const over = applyProgress({ ...row(3, 2, 1), name: 'Burger' }, { preparedQty: 4 })
    check('more than was ordered is refused', !over.ok && over.refusal.code === 'PROGRESS_OVER_QUANTITY')
    const unprepared = applyProgress({ ...row(3, 1, 0), name: 'Burger' }, { servedQty: 2 })
    check('serving what is not made is refused', !unprepared.ok && unprepared.refusal.code === 'PROGRESS_UNPREPARED')
    const same = applyProgress({ ...row(3, 2, 1, 'PREPARING'), name: 'Burger' }, { preparedQty: 2 })
    check('the same again is a no-op, not a refusal', same.ok && !same.changed)
    const catchUp = applyProgress({ ...row(3, 2, 1), name: 'Burger' }, { preparedQty: 2 })
    check('but a status behind its counters is corrected', catchUp.ok && catchUp.changed && catchUp.status === 'PREPARING')
    const both = applyProgress({ ...row(3, 0, 0), name: 'Burger' }, { preparedQty: 3, servedQty: 3 })
    check('prepared and served in one go', both.ok && both.changed && both.status === 'SERVED')

    // The spec's three examples, by quantity.
    const ex1 = summariseProgress([row(3, 1, 0)])
    check('3 ordered, 1 prepared, 0 served → Remaining 2', ex1.prepared === 1 && ex1.served === 0 && ex1.remaining === 2)
    const ex2 = summariseProgress([row(3, 3, 1)])
    check('3 ordered, 2 prepared, 1 served → Remaining 0', ex2.prepared === 2 && ex2.served === 1 && ex2.remaining === 0)
    const ex3 = summariseProgress([row(3, 3, 3)])
    check('3 ordered, 3 served → Remaining 0, Prepared 0', ex3.prepared === 0 && ex3.served === 3 && ex3.remaining === 0)
    check('served is never counted as prepared', ex2.prepared + ex2.served + ex2.remaining === ex2.ordered)
    const mixed = summariseProgress([row(3, 2, 0), row(1, 1, 1), row(2, 0, 0), { ...row(4, 4, 4), status: 'CANCELLED' as never }])
    check('lines add up by quantity, cancelled outside', mixed.ordered === 6 && mixed.prepared === 2 && mixed.served === 1 && mixed.remaining === 3)

    check('"2 of 3 ready" is the label mid-way', progressLabel(row(3, 2, 0)) === '2 of 3 ready')
    check('"1 of 3 served" once plates go out', progressLabel(row(3, 3, 1)) === '1 of 3 served')
    check('nothing to say when all is done or nothing has moved', progressLabel(row(3, 3, 3)) === null && progressLabel(row(3, 0, 0)) === null)
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Progress ${stamp}`, slug: `progress-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const table = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, number: '1', capacity: 4 },
  })
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const food = async (name: string) => {
    const row = await prisma.food.create({
      data: { restaurantId: restaurant.id, categoryId: category.id, name, slug: `${name.toLowerCase()}-${stamp}`, price: 50_000, isAvailable: true },
    })
    await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: row.id, branchId: branch.id, isAvailable: true } })
    return row
  }
  const burger = await food('Burger')
  const rice = await food('Rice')
  const pasta = await food('Pasta')
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `progress-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: branch.id },
  })
  const actor = { actorId: cashier.id, actorName: cashier.name }

  const order = (items: Array<{ foodId: string; quantity: number }>) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId: table.id, type: 'DINE_IN',
      items: items.map((item) => ({ ...item, optionIds: [] })),
      customerName: 'Perera', customerPhone: '0770000000',
    })
  const step = (orderId: string, status: 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED') =>
    updateOrderStatus({ restaurantId: restaurant.id, orderId, status, ...actor })
  const lines = (orderId: string) =>
    prisma.orderItem.findMany({ where: { orderId }, orderBy: { name: 'asc' } })
  const line = async (orderId: string, name: string) =>
    (await lines(orderId)).find((item) => item.name === name)!
  const progress = (orderId: string, updates: Array<{ itemId: string; preparedQty?: number; servedQty?: number }>) =>
    progressItems({ restaurantId: restaurant.id, orderId, updates, ...actor })

  console.log('\n── 2. Ticking a ticket, plate by plate ──')
  const a = await order([{ foodId: burger.id, quantity: 3 }, { foodId: rice.id, quantity: 1 }, { foodId: pasta.id, quantity: 2 }])
  {
    const burgers = await line(a.id, 'Burger')
    // A staff order is accepted by being typed in (aO.md §1); the ticket that
    // nobody has taken on is a guest's, waiting at the till.
    // Its own table: a QR guest cannot start an order at a table in use (aO.md §2).
    const spare = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, branchId: branch.id, number: '2', capacity: 2 },
    })
    const waiting = await placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId: spare.id, type: 'DINE_IN', channel: 'QR',
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      customerName: 'Scanner', customerPhone: '0770000001',
    })
    const waitingLine = await line(waiting.id, 'Rice')
    await refuses('a ticket nobody has taken on refuses', () => progress(waiting.id, [{ itemId: waitingLine.id, preparedQty: 1 }]), /ORDER_NOT_ACCEPTED/)
    await cancelOrder({ restaurantId: restaurant.id, orderId: waiting.id, reason: 'Test' })
    check('a staff order is accepted the moment it is typed in', a.status === 'ACCEPTED' && a.acceptedAt !== null)
    await step(a.id, 'ACCEPTED')

    const one = await progress(a.id, [{ itemId: burgers.id, preparedQty: 1 }])
    const after1 = await line(a.id, 'Burger')
    check('one of three burgers made: the line is Preparing', after1.status === 'PREPARING' && after1.preparedQty === 1 && after1.servedQty === 0)
    check('stamped when it started', after1.preparingAt !== null && after1.readyAt === null)
    check('the order follows: Preparing', one.order.status === 'PREPARING')
    check('what moved is reported, before and after', one.changed.length === 1 && one.changed[0].before.preparedQty === 0 && one.changed[0].after.preparedQty === 1)

    await refuses('backwards is refused', () => progress(a.id, [{ itemId: burgers.id, preparedQty: 0 }]), /PROGRESS_BACKWARDS/)
    await refuses('more than ordered is refused', () => progress(a.id, [{ itemId: burgers.id, preparedQty: 4 }]), /PROGRESS_OVER_QUANTITY/)
    await refuses('serving two when one is made is refused', () => progress(a.id, [{ itemId: burgers.id, servedQty: 2 }]), /PROGRESS_UNPREPARED/)
    const again = await progress(a.id, [{ itemId: burgers.id, preparedQty: 1 }])
    check('the same tick twice changes nothing', again.changed.length === 0)

    // Select all: every line to its full quantity, in one call.
    const all = await lines(a.id)
    const selectAll = await progress(a.id, all.map((item) => ({ itemId: item.id, preparedQty: item.quantity })))
    const afterAll = await lines(a.id)
    check('Select all makes every line Ready', afterAll.every((item) => item.status === 'READY' && item.preparedQty === item.quantity))
    check('each line stamped ready once', afterAll.every((item) => item.readyAt !== null))
    check('the order is Ready, with its own stamp', selectAll.order.status === 'READY' && selectAll.order.readyAt !== null)
    check('three lines moved in one transaction', selectAll.changed.length === 3)

    const served1 = await progress(a.id, [{ itemId: burgers.id, servedQty: 1 }])
    const afterServe1 = await line(a.id, 'Burger')
    check('one burger out: the line is still Ready, 1 of 3 served', afterServe1.status === 'READY' && afterServe1.servedQty === 1 && afterServe1.servedAt === null)
    check('and the order stays Ready', served1.order.status === 'READY')

    const finished = await lines(a.id)
    const servedAll = await progress(a.id, finished.map((item) => ({ itemId: item.id, servedQty: item.quantity })))
    const done = await lines(a.id)
    check('everything out: every line Served and stamped', done.every((item) => item.status === 'SERVED' && item.servedQty === item.quantity && item.servedAt !== null))
    check('the order is Served', servedAll.order.status === 'SERVED' && servedAll.order.servedAt !== null)
  }

  console.log('\n── 3. Closed orders and cancelled lines refuse ──')
  {
    const b = await order([{ foodId: burger.id, quantity: 2 }, { foodId: rice.id, quantity: 1 }])
    await step(b.id, 'ACCEPTED')
    const riceLine = await line(b.id, 'Rice')
    await prisma.orderItem.update({ where: { id: riceLine.id }, data: { status: 'CANCELLED' } })
    await refuses('a cancelled line refuses', () => progress(b.id, [{ itemId: riceLine.id, preparedQty: 1 }]), /ITEM_CANCELLED/)
    const stranger = await line(a.id, 'Rice')
    await refuses("another order's line is not found", () => progress(b.id, [{ itemId: stranger.id, preparedQty: 1 }]), /not found/i)
    await cancelOrder({ restaurantId: restaurant.id, orderId: b.id, reason: 'Test' })
    const burgers = await line(b.id, 'Burger')
    await refuses('a cancelled order refuses', () => progress(b.id, [{ itemId: burgers.id, preparedQty: 1 }]), /ORDER_CLOSED/)
  }

  console.log('\n── 4. The order-level cascades carry the counters ──')
  {
    const c = await order([{ foodId: burger.id, quantity: 3 }, { foodId: pasta.id, quantity: 2 }])
    await step(c.id, 'ACCEPTED')
    await step(c.id, 'PREPARING')
    await step(c.id, 'READY')
    const ready = await lines(c.id)
    check('Mark ready on the ticket makes every line 3 of 3', ready.every((item) => item.status === 'READY' && item.preparedQty === item.quantity && item.servedQty === 0))
    await step(c.id, 'SERVED')
    const served = await lines(c.id)
    check('Handed over makes every line fully served', served.every((item) => item.status === 'SERVED' && item.servedQty === item.quantity))
  }

  console.log('\n── 5. Splitting keeps the made plates with the original ──')
  {
    const d = await order([{ foodId: burger.id, quantity: 3 }, { foodId: rice.id, quantity: 1 }])
    await step(d.id, 'ACCEPTED')
    const burgers = await line(d.id, 'Burger')
    await progress(d.id, [{ itemId: burgers.id, preparedQty: 2, servedQty: 1 }])

    const { source, target } = await splitBill({
      restaurantId: restaurant.id, orderId: d.id, selections: [{ itemId: burgers.id, quantity: 1 }], ...actor,
    })
    const kept = await line(source.id, 'Burger')
    const moved = await line(target.id, 'Burger')
    check('the original keeps two of three, both made, one out', kept.quantity === 2 && kept.preparedQty === 2 && kept.servedQty === 1 && kept.status === 'READY')
    check('the moved burger starts from nothing', moved.quantity === 1 && moved.preparedQty === 0 && moved.servedQty === 0 && moved.status !== 'READY' && moved.status !== 'SERVED')
    check('the database accepted both rows', kept.servedQty <= kept.preparedQty && kept.preparedQty <= kept.quantity && moved.preparedQty <= moved.quantity)

    // Move two of three when all three are made and two are out: the
    // original keeps one made and one out; the moved line has one made, one out.
    const e = await order([{ foodId: pasta.id, quantity: 3 }, { foodId: rice.id, quantity: 1 }])
    await step(e.id, 'ACCEPTED')
    const pastas = await line(e.id, 'Pasta')
    await progress(e.id, [{ itemId: pastas.id, preparedQty: 3, servedQty: 2 }])
    const split2 = await splitBill({
      restaurantId: restaurant.id, orderId: e.id, selections: [{ itemId: pastas.id, quantity: 2 }], ...actor,
    })
    const kept2 = await line(split2.source.id, 'Pasta')
    const moved2 = await line(split2.target.id, 'Pasta')
    check('kept-first: the original holds one made and out', kept2.quantity === 1 && kept2.preparedQty === 1 && kept2.servedQty === 1 && kept2.status === 'SERVED')
    check('the rest travels: two made, one of them out', moved2.quantity === 2 && moved2.preparedQty === 2 && moved2.servedQty === 1 && moved2.status === 'READY')

    const merged = await mergeBills({ restaurantId: restaurant.id, targetId: split2.source.id, sourceIds: [split2.target.id], ...actor })
    const back = await prisma.orderItem.findMany({ where: { orderId: merged.id, name: 'Pasta' } })
    check('merging carries the counters across untouched', back.length === 2 && back.reduce((s, i) => s + i.preparedQty, 0) === 3 && back.reduce((s, i) => s + i.servedQty, 0) === 2)
  }

  console.log('\n── 6. The live floor: Ordered / Prepared / Served / Remaining ──')
  {
    const f = await order([{ foodId: burger.id, quantity: 3 }])
    await step(f.id, 'ACCEPTED')
    const burgers = await line(f.id, 'Burger')
    const floor = async () =>
      (await getLiveBoard({ restaurantId: restaurant.id, branchId: branch.id })).orders.find((row) => row.orderId === f.id)!

    await progress(f.id, [{ itemId: burgers.id, preparedQty: 1 }])
    const one = await floor()
    check('3 ordered, 1 prepared, 0 served → Remaining 2', one.ordered === 3 && one.ready === 1 && one.served === 0 && one.remaining === 2, JSON.stringify(one))
    check('and the kitchen has two in front of it', one.preparing === 2)

    await progress(f.id, [{ itemId: burgers.id, preparedQty: 3, servedQty: 1 }])
    const two = await floor()
    check('3 ordered, 2 prepared, 1 served → Remaining 0', two.ordered === 3 && two.ready === 2 && two.served === 1 && two.remaining === 0, JSON.stringify(two))

    await progress(f.id, [{ itemId: burgers.id, servedQty: 3 }])
    const three = await floor()
    check('3 ordered, 3 served → Remaining 0, nothing waiting', three.ordered === 3 && three.ready === 0 && three.served === 3 && three.remaining === 0, JSON.stringify(three))
    check('Remaining = Ordered − Prepared − Served throughout', [one, two, three].every((row) => row.remaining === row.ordered - row.ready - row.served))
  }

  console.log('\n── 7. The action, the event, the boards ──')
  {
    const actions = readFileSync('src/features/orders/actions.ts', 'utf8')
    const action = actions.slice(actions.indexOf('export async function progressItemsAction'), actions.indexOf('async function auditProgress'))
    check('gated on order.update_status', action.includes('PERMISSIONS.ORDER_UPDATE_STATUS'))
    check("scoped to the order's site", action.includes("assertRecordBranch(user, await orderBranch(user.restaurantId, data.orderId), 'order')"))
    check('audited under its own key', actions.includes('AUDIT_ACTIONS.ORDER_ITEM_PROGRESS'))
    const legacy = actions.slice(actions.indexOf('export async function updateItemStatus'), actions.indexOf('export async function progressItemsAction'))
    check('the status-shaped action is a face over the same service', legacy.includes('await progressItems('))

    const emitter = readFileSync('src/server/realtime/emitter.ts', 'utf8')
    check("the line event reaches every board and the guest's room", /orderItemStatus[\s\S]*?\['kitchen', 'waiter', 'cashier', 'management'\][\s\S]*?ROOM\.order\(payload\.orderId\)/.test(emitter))
    const events = readFileSync('src/lib/realtime/events.ts', 'utf8')
    check('and carries the counters', /interface OrderItemProgressPayload[\s\S]*?preparedQty: number[\s\S]*?servedQty: number/.test(events))

    const kds = readFileSync('src/features/kitchen/components/kitchen-board.tsx', 'utf8')
    check('the KDS has a box per line and Select all', kds.includes('aria-label={`${item.name} prepared`}') && kds.includes('aria-label="Select all"'))
    // DELIBERATE behaviour change 2026-09 (aO.md §1): the KDS has no "New
    // orders" column any more — every ticket on it is accepted, so every
    // ticket has its boxes.
    check('the KDS has no column for orders nobody has taken on', !kds.includes("statuses: ['PENDING']") && !kds.includes('acceptOrderAction'))
    const tracker = readFileSync('src/features/orders/components/order-tracker.tsx', 'utf8')
    check('the guest tracker listens to the line event', tracker.includes('useSocketEvent(EVENTS.ORDER_ITEM_STATUS'))
    const waiter = readFileSync('src/features/waiter/components/waiter-board.tsx', 'utf8')
    check('the waiter serves what is prepared, by quantity', waiter.includes('servedQty: item.preparedQty'))
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
