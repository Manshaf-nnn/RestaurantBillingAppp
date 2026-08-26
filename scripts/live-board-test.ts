/**
 * The live floor board.
 *
 * ── What this is guarding ───────────────────────────────────────────────────
 *
 * A board about elapsed time is easy to write and hard to keep honest. Every
 * check below is a way it could quietly mislead the person watching it:
 *
 *   · a table that has served somebody once never reading as occupied again
 *   · a fully-served order stuck at PREPARING, permanently critical at 100%
 *   · every walk-in recognised as the same VIP with hundreds of visits
 *   · a party's current sitting counted as its own previous visit
 *   · one late table filling the alert strip with three rows about itself
 *
 * The first three FAIL against the code as it was. They are existing bugs the
 * board would have displayed rather than caused, which is why they are fixed
 * here.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/live-board-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { getLiveBoard } from '../src/features/live/queries'
import { DEFAULT_LIVE_POLICY, type LiveBoardPolicy } from '../src/features/live/policy'
import {
  alertBoard,
  alertsFor,
  daysBetween,
  foldOrdersToTables,
  kpis,
  progressPct,
  recognise,
  waitBand,
  waitingPriority,
  type CustomerHistoryRow,
  type LiveTable,
} from '../src/features/live/derive'

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

const MIN = 60_000
const NOW = Date.parse('2026-08-26T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString()

/** A table with sensible defaults, for the pure-function checks. */
function table(over: Partial<LiveTable> = {}): LiveTable {
  return {
    key: 't1', tableId: 't1', tableNumber: '08', tableLabel: null, area: null,
    capacity: 4, guestCount: null, orderIds: ['o1'], primaryOrderId: 'o1',
    orderNumber: 'A-1', seatedAt: ago(10), latestOrderAt: ago(10),
    acceptedAt: null, preparingAt: null, readyAt: null, servedAt: null,
    ordered: 5, queued: 0, preparing: 0, ready: 0, served: 0, cancelled: 0,
    outstanding: 5000, paymentStatus: 'UNPAID', customer: null,
    walkInName: 'Walk-in', serviceCalls: [],
    ...over,
  }
}

async function main() {
  const P = DEFAULT_LIVE_POLICY

  console.log('\n── 1. Progress uses quantities, not line counts ────────────')

  check('one line of five reads five', progressPct({ ordered: 5, served: 0 }) === 0)
  check('partial serving works', progressPct({ ordered: 5, served: 2 }) === 40)
  check('all out is 100%', progressPct({ ordered: 5, served: 5 }) === 100)
  // 5 ordered, 1 cancelled, 2 served: the denominator is 4, so 50% — not 40%.
  check('cancelled is out of the denominator', progressPct({ ordered: 4, served: 2 }) === 50)
  check('an all-cancelled order is 0%, not NaN', progressPct({ ordered: 0, served: 0 }) === 0)

  console.log('\n── 2. Band edges have no gap and no overlap ────────────────')

  check('exactly 10 is still normal', waitBand(10, P) === 'NORMAL')
  check('11 is watch', waitBand(11, P) === 'WATCH')
  check('15 is watch', waitBand(15, P) === 'WATCH')
  check('16 is attention', waitBand(16, P) === 'ATTENTION')
  check('21 is delayed', waitBand(21, P) === 'DELAYED')
  check('31 is critical', waitBand(31, P) === 'CRITICAL')

  const tight: LiveBoardPolicy = { ...P, normalMax: 2, watchMax: 3, attentionMax: 4, delayedMax: 5 }
  check('and the bands follow the policy, not a constant', waitBand(3, tight) === 'WATCH')

  console.log('\n── 3. One table, one alert row ─────────────────────────────')

  // 32 minutes, 40% served, 3 preparing since acceptance: matches four rules.
  const late = table({
    seatedAt: ago(32), latestOrderAt: ago(32), acceptedAt: ago(30), preparingAt: ago(30),
    ordered: 5, preparing: 3, served: 2,
  })
  const alert = alertsFor(late, P, NOW)
  check('it produces exactly one row', alert !== null)
  check('led by the worst thing wrong', alert?.severity === 'CRITICAL', `${alert?.severity}`)
  check('with the rest as a subline', (alert?.also.length ?? 0) >= 1, `${alert?.also.length}`)
  // The three bands are one measurement read against different bars.
  check(
    'and only ONE waiting reason',
    (alert ? [alert.headline, ...alert.also] : []).filter((r) => r.code === 'WAIT').length <= 1,
  )

  console.log('\n── 4. Alerts clear themselves ──────────────────────────────')

  const done = table({ seatedAt: ago(32), ordered: 5, served: 5, paymentStatus: 'PAID' })
  check('serving everything ends the alert', alertsFor(done, P, NOW) === null)
  check('and stops the waiting clock', waitingPriority([done], NOW).length === 0)

  const readyOnly = table({ ordered: 5, served: 0, ready: 0, readyAt: ago(30) })
  check(
    'ready-not-served does not fire with nothing ready',
    !(alertsFor(readyOnly, P, NOW) ?? { also: [] as Array<{ code: string }> })
      .also.some((r) => r.code === 'READY_NOT_SERVED'),
  )

  console.log('\n── 5. A second round is its own wait ───────────────────────')

  const twoRounds = table({
    seatedAt: ago(100), latestOrderAt: ago(6), ordered: 8, served: 5,
  })
  // Their starters came an hour ago; the puddings are six minutes old. A board
  // shouting "80 minutes" about a party mid-meal is noise.
  check('waiting is measured from the late round', waitingPriority([twoRounds], NOW)[0].minutes === 6)
  check(
    'but the sitting is still long enough to mention',
    (alertsFor(twoRounds, P, NOW)?.also ?? []).some((r) => r.code === 'LONG_SERVICE') ||
      alertsFor(twoRounds, P, NOW)?.headline.code === 'LONG_SERVICE',
  )

  console.log('\n── 6. Recognition ──────────────────────────────────────────')

  const history = (over: Partial<CustomerHistoryRow> = {}): CustomerHistoryRow => ({
    customerId: 'c1', name: 'Priya', phone: '0771234567',
    completedVisits: 0, lifetimeSpend: 0, previousVisitAt: null, ...over,
  })
  const seen = (h: CustomerHistoryRow) =>
    recognise({ history: h, visitStartedAt: ago(5), policy: P, timeZone: 'Asia/Colombo' })

  check('nobody on file is a first visit', seen(history()).tier === 'FIRST_VISIT')
  check('and has no return gap', seen(history()).gap === 'NONE')
  check('two visits is returning', seen(history({ completedVisits: 2 })).tier === 'RETURNING')
  check('five is a regular', seen(history({ completedVisits: 5 })).tier === 'REGULAR')
  check('fifteen is a VIP', seen(history({ completedVisits: 15 })).tier === 'VIP')

  const bySpend = recognise({
    history: history({ completedVisits: 3, lifetimeSpend: 500_000 }),
    visitStartedAt: ago(5),
    policy: { ...P, vipAfterSpend: 400_000 },
    timeZone: 'Asia/Colombo',
  })
  check('spending enough also makes a VIP', bySpend.tier === 'VIP')

  const away = (days: number) =>
    seen(history({
      completedVisits: 6,
      previousVisitAt: new Date(NOW - days * 24 * 3600_000).toISOString(),
    }))

  check('back within a month gets no badge', away(10).gap === 'NONE')
  check('thirty days is a welcome back', away(30).gap === 'WELCOME_BACK')
  check('ninety is a long-time return', away(120).gap === 'LONG_TIME_RETURN')
  // Two axes, not five tiers — a regular who has been away is both.
  check('and it coexists with the tier', away(120).tier === 'REGULAR')
  check('the gap is counted in days', away(120).returnedAfterDays === 120, `${away(120).returnedAfterDays}`)

  /*
   * Both instants land on a different LOCAL day than their UTC one: 20:00Z is
   * already the 15th in Colombo, and 02:00Z is still the 26th. Counting in UTC
   * would give a different answer, which is the whole reason this takes a zone.
   */
  check(
    'days are counted in the restaurant’s calendar',
    daysBetween('2026-03-14T20:00:00.000Z', '2026-08-26T02:00:00.000Z', 'Asia/Colombo') === 164,
    `${daysBetween('2026-03-14T20:00:00.000Z', '2026-08-26T02:00:00.000Z', 'Asia/Colombo')}`,
  )
  check(
    'and the zone genuinely changes the count',
    daysBetween('2026-03-14T20:00:00.000Z', '2026-08-26T02:00:00.000Z', 'UTC') === 165,
  )

  console.log('\n── 7. The tiles agree with the cards ───────────────────────')

  const floor = [
    table({ key: 'a', tableId: 'a', ordered: 5, served: 2, seatedAt: ago(32), latestOrderAt: ago(32) }),
    table({ key: 'b', tableId: 'b', ordered: 4, served: 4, seatedAt: ago(20), latestOrderAt: ago(20) }),
    table({ key: 'c', tableId: 'c', ordered: 3, served: 0, seatedAt: ago(5), latestOrderAt: ago(5) }),
  ]
  const tiles = kpis({ tables: floor, tablesTotal: 32, policy: P, now: NOW })
  check('occupied counts every seated party', tiles.tablesOccupied === 3)
  check('waiting excludes the fully-served table', tiles.waitingTables === 2, `${tiles.waitingTables}`)
  check('delayed follows the bands', tiles.delayedTables === 1, `${tiles.delayedTables}`)
  check('ordered is the sum of quantities', tiles.ordered === 12)
  check('served likewise', tiles.served === 6)
  check('and the percentage matches', tiles.servedPct === 50, `${tiles.servedPct}`)
  check(
    'the delayed tile equals the delayed cards',
    tiles.delayedTables ===
      alertBoard(floor, P, NOW).filter((a) => a.severity === 'CRITICAL' || a.severity === 'DELAYED').length,
  )

  console.log('\n── 8. Against real data ────────────────────────────────────')

  const stamp = Date.now().toString(36)
  const shop = await prisma.restaurant.create({
    data: {
      name: `Live ${stamp}`, slug: `live-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const t8 = await prisma.restaurantTable.create({
    data: { restaurantId: shop.id, branchId: branch.id, number: '08', capacity: 4 },
  })
  const category = await prisma.category.create({
    data: { restaurantId: shop.id, name: 'Mains', slug: `m-${stamp}` },
  })
  const rice = await prisma.food.create({
    data: {
      restaurantId: shop.id, categoryId: category.id, name: 'Rice',
      slug: `rice-${stamp}`, price: 50_000, isAvailable: true,
    },
  })

  // A branch sells what its own menu lists; `buildDraft` refuses anything else.
  await prisma.foodBranch.create({
    data: { restaurantId: shop.id, foodId: rice.id, branchId: branch.id, isAvailable: true },
  })

  const order = await placeOrder({
    restaurantId: shop.id,
    branchId: branch.id,
    tableId: t8.id,
    type: 'DINE_IN',
    items: [{ foodId: rice.id, quantity: 5, optionIds: [] }],
    customerName: 'Ahamed',
    customerPhone: '0771111111',
  })

  const board = await getLiveBoard({ restaurantId: shop.id, branchId: branch.id })
  check('the open order is on the board', board.orders.length === 1)
  check('with its quantities rolled up', board.orders[0].ordered === 5, `${board.orders[0].ordered}`)
  check('nothing served yet', board.orders[0].served === 0)
  check('and the floor size is known', board.tablesTotal === 1)

  // A first sitting is a first visit: their current order is COMPLETED-less.
  check('a brand-new guest has no completed visits', board.history[0]?.completedVisits === 0)
  check('and therefore no previous visit', board.history[0]?.previousVisitAt === null)

  const folded = foldOrdersToTables({
    orders: board.orders,
    history: new Map(board.history.map((h) => [h.customerId, h])),
    calls: board.calls,
    policy: P,
    timeZone: 'Asia/Colombo',
  })
  check('one table, one card', folded.length === 1)
  check('recognised as a first visit', folded[0].customer?.tier === 'FIRST_VISIT')

  console.log('\n── 9. Re-seating a cleaned table ───────────────────────────')

  // FAILS BEFORE THE CHANGE. A settled table lands in CLEANING and only a
  // busser clears it, so the next party never marked the table occupied.
  await updateOrderStatus({
    restaurantId: shop.id, orderId: order.id, status: 'ACCEPTED', actorId: null, actorName: null,
  })
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'COMPLETED', paymentStatus: 'PAID', completedAt: new Date() },
  })
  await prisma.restaurantTable.update({ where: { id: t8.id }, data: { status: 'CLEANING' } })

  await placeOrder({
    restaurantId: shop.id, branchId: branch.id, tableId: t8.id, type: 'DINE_IN',
    items: [{ foodId: rice.id, quantity: 2, optionIds: [] }],
    customerName: 'Second party', customerPhone: '0772222222',
  })
  const reseated = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t8.id } })
  check('a CLEANING table is occupied by the next party', reseated.status === 'OCCUPIED', reseated.status)

  // …but a table mid-service keeps the finer state a waiter set by hand.
  await prisma.restaurantTable.update({ where: { id: t8.id }, data: { status: 'WAITING_BILL' } })
  await placeOrder({
    restaurantId: shop.id, branchId: branch.id, tableId: t8.id, type: 'DINE_IN',
    items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
    customerName: 'Second party', customerPhone: '0772222222',
  })
  const stillWaiting = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t8.id } })
  check('a second round does not stomp WAITING_BILL', stillWaiting.status === 'WAITING_BILL', stillWaiting.status)

  console.log('\n── 10. Two open orders are one card ────────────────────────')

  const board2 = await getLiveBoard({ restaurantId: shop.id, branchId: branch.id })
  check('two open orders on the table', board2.orders.length === 2)
  const folded2 = foldOrdersToTables({
    orders: board2.orders,
    history: new Map(board2.history.map((h) => [h.customerId, h])),
    calls: board2.calls, policy: P, timeZone: 'Asia/Colombo',
  })
  check('folded to a single card', folded2.length === 1, `${folded2.length}`)
  check('with both rounds added up', folded2[0].ordered === 3, `${folded2[0].ordered}`)
  check('and one alert at most', alertBoard(folded2, P, Date.now()).length <= 1)

  console.log('\n── 11. The previous visit is never the current one ─────────')

  const returning = await prisma.customer.findFirstOrThrow({ where: { phone: '0772222222' } })
  const hist = await getLiveBoard({ restaurantId: shop.id, branchId: branch.id })
  const theirs = hist.history.find((h) => h.customerId === returning.id)
  // They are sitting there right now with two open orders and no completed
  // ones. If the sitting counted itself, this would be 2.
  check('an open sitting counts as no visits', theirs?.completedVisits === 0, `${theirs?.completedVisits}`)
  check('and yields no previous visit', theirs?.previousVisitAt === null)

  console.log('\n── 12. A walk-in is not a person ───────────────────────────')

  /*
   * FAILS BEFORE THE CHANGE. `placeOrder` upserts the customer on
   * `(restaurantId, phone)` unconditionally and the till sends '' for an
   * anonymous sale, so every walk-in feeds ONE shared row — which would have
   * been rendered as a VIP with a visit for every cash sale ever rung up.
   */
  for (let i = 0; i < 3; i += 1) {
    await placeOrder({
      restaurantId: shop.id, branchId: branch.id, type: 'TAKEAWAY',
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      customerName: 'Walk-in', customerPhone: '',
    })
  }
  const shared = await prisma.customer.findFirst({ where: { restaurantId: shop.id, phone: '' } })
  check('the shared walk-in row does exist in the data', shared !== null)
  check('and has collected every anonymous sale', (shared?.totalOrders ?? 0) >= 3, `${shared?.totalOrders}`)

  const board3 = await getLiveBoard({ restaurantId: shop.id, branchId: branch.id })
  check(
    'but the board never treats it as a customer',
    !board3.history.some((h) => h.phone === ''),
  )
  const walkIns = board3.orders.filter((o) => o.customerPhone === '')
  check('and their orders carry no customer id', walkIns.every((o) => o.customerId === null))
  const folded3 = foldOrdersToTables({
    orders: board3.orders,
    history: new Map(board3.history.map((h) => [h.customerId, h])),
    calls: board3.calls, policy: P, timeZone: 'Asia/Colombo',
  })
  check(
    'so no walk-in card claims a tier',
    folded3.filter((t) => t.tableId === null).every((t) => t.customer === null),
  )

  console.log('\n── 13. Branch isolation ────────────────────────────────────')

  const other = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Kandy', code: 'KND' },
  })
  const otherBoard = await getLiveBoard({ restaurantId: shop.id, branchId: other.id })
  check('another branch’s board is empty', otherBoard.orders.length === 0)
  check('and sees none of this floor', otherBoard.tablesTotal === 0)

  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: shop.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.customer.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.food.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.category.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.delete({ where: { id: shop.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
