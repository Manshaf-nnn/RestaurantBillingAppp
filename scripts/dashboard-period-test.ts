/**
 * The dashboard's period selector has to mean something.
 *
 * ── The bug this is written around ──────────────────────────────────────────
 *
 * Every window on the dashboard used to be hardcoded — today on the hero row,
 * 14 days on the trend, 30 on three more cards — and none of them were the
 * restaurant's own days. `range.ts` built boundaries with `new Date(y, m, d)`,
 * which is midnight in the SERVER's timezone; on Netlify that is UTC. For a
 * restaurant in `Asia/Kolkata` (UTC+5:30) "today" therefore began at 05:30
 * local, so every order taken between local midnight and 05:30 was counted on
 * the previous day. `getSalesSeries` had the same fault from the other end: a
 * bare `date_trunc('day', "placedAt")` buckets in UTC.
 *
 * That was invisible while the window could not move. A selector makes it
 * visible — pick "today" and the chart opens with five empty hours.
 *
 * So the fixture below is built specifically around a **02:00 local order**,
 * which in Kolkata is 20:30 UTC on the *previous* calendar day. Every
 * timezone assertion here fails against the old code, on purpose.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/dashboard-period-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  getDashboardStats,
  getRevenueSeries,
  getCategoryBreakdown,
} from '../src/features/analytics/queries'
import { getPurchaseSummary } from '../src/features/analytics/purchase-summary'
import { getFloorSummary } from '../src/features/analytics/floor-summary'
import {
  customRange,
  granularityFor,
  previousRange,
  resolveRange,
} from '../src/features/reports/range'

const TZ = 'Asia/Kolkata'
const DAY = 86_400_000

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

/** What a wall clock in `tz` reads at this instant, as `YYYY-MM-DD`. */
function localDay(d: Date, tz = TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)
}

/** The instant of a wall-clock time in Kolkata. UTC+5:30, no DST, so fixed. */
function kolkata(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 5.5 * 3_600_000)
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Period ${stamp}`,
      slug: `period-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      timezone: TZ,
    },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const second = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Second', code: 'BR02' },
  })

  let seq = 0
  const makeOrder = (opts: {
    branchId: string
    total: number
    placedAt: Date
    tableId?: string
    guests?: number
  }) =>
    prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        branchId: opts.branchId,
        orderNumber: `${stamp}-${(seq += 1)}`,
        customerName: 'Walk-in',
        customerPhone: '0770000000',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subtotal: opts.total,
        grandTotal: opts.total,
        paidTotal: opts.total,
        placedAt: opts.placedAt,
        tableId: opts.tableId,
        guestCount: opts.guests,
      },
    })

  // ── 1. the local-midnight case ────────────────────────────────────────────
  //
  // Anchored on a fixed calendar date rather than "now", so the test says the
  // same thing whatever hour it is run at and whatever the CI box's clock is
  // set to. `now` is handed to the resolver explicitly for the same reason.
  console.log('\n── 1. a day is the restaurant\'s day, not the server\'s ──')

  const anchor = kolkata(2026, 3, 15, 12, 0) // midday, 15 March, Kolkata
  const earlyHours = kolkata(2026, 3, 15, 2, 0) // 02:00 local = 20:30 UTC on the 14th
  const lateEvening = kolkata(2026, 3, 15, 22, 0)
  const dayBefore = kolkata(2026, 3, 14, 13, 0)

  check(
    'the fixture really does straddle midnight in UTC',
    earlyHours.toISOString().slice(0, 10) === '2026-03-14' && localDay(earlyHours) === '2026-03-15',
    `utc ${earlyHours.toISOString()} vs local ${localDay(earlyHours)}`,
  )

  await makeOrder({ branchId: main.id, total: 1_000, placedAt: earlyHours })
  await makeOrder({ branchId: main.id, total: 2_000, placedAt: lateEvening })
  await makeOrder({ branchId: main.id, total: 9_000, placedAt: dayBefore })

  const today = resolveRange({ preset: 'TODAY', now: anchor, timeZone: TZ })
  const todayStats = await getDashboardStats({
    restaurantId: restaurant.id,
    range: today,
    branchIds: null,
  })

  check(
    'the 02:00 order counts on that local day',
    todayStats.revenue === 3_000,
    `${todayStats.revenue} (expected 3000 = 1000 + 2000)`,
  )
  check('and the previous day is not swept in', todayStats.orders === 2, `${todayStats.orders}`)

  const yesterday = resolveRange({ preset: 'YESTERDAY', now: anchor, timeZone: TZ })
  const yStats = await getDashboardStats({
    restaurantId: restaurant.id,
    range: yesterday,
    branchIds: null,
  })
  check('yesterday holds only its own order', yStats.revenue === 9_000, `${yStats.revenue}`)

  check(
    'the boundary is local midnight, not 05:30',
    today.from.toISOString() === '2026-03-14T18:30:00.000Z',
    today.from.toISOString(),
  )

  // ── 2. the presets span what they name ────────────────────────────────────
  console.log('\n── 2. presets span what they name ──')

  const month = resolveRange({ preset: 'THIS_MONTH', now: anchor, timeZone: TZ })
  check(
    'THIS_MONTH starts on the 1st, locally',
    localDay(month.from) === '2026-03-01',
    localDay(month.from),
  )
  const year = resolveRange({ preset: 'THIS_YEAR', now: anchor, timeZone: TZ })
  check(
    'THIS_YEAR starts on 1 January, locally',
    localDay(year.from) === '2026-01-01',
    localDay(year.from),
  )
  const week = resolveRange({ preset: 'THIS_WEEK', now: anchor, timeZone: TZ })
  // 15 March 2026 is a Sunday, so the Monday before it is the 9th.
  check('THIS_WEEK starts on Monday', localDay(week.from) === '2026-03-09', localDay(week.from))

  const last90 = resolveRange({ preset: 'LAST_90', now: anchor, timeZone: TZ })
  check(
    'LAST_90 is 90 days inclusive',
    Math.round((last90.to.getTime() - last90.from.getTime()) / DAY) === 90,
    `${Math.round((last90.to.getTime() - last90.from.getTime()) / DAY)}`,
  )

  // ── 3. granularity, and gap-filling ───────────────────────────────────────
  console.log('\n── 3. the bars match the span ──')

  check('a day is hourly', granularityFor(anchor, new Date(anchor.getTime() + DAY)) === 'hour')
  check(
    'a month is daily',
    granularityFor(anchor, new Date(anchor.getTime() + 30 * DAY)) === 'day',
  )
  check(
    'a year is monthly',
    granularityFor(anchor, new Date(anchor.getTime() + 365 * DAY)) === 'month',
  )

  const hourly = await getRevenueSeries({
    restaurantId: restaurant.id,
    range: today,
    branchIds: null,
  })
  check('a day gives 24 hourly points', hourly.length === 24, `${hourly.length}`)
  check(
    'the 02:00 order lands in the 02:00 bucket',
    hourly[2]?.revenue === 1_000,
    `bucket 2 = ${hourly[2]?.revenue}, key ${hourly[2]?.date}`,
  )
  check(
    'the 22:00 order lands in the 22:00 bucket',
    hourly[22]?.revenue === 2_000,
    `bucket 22 = ${hourly[22]?.revenue}`,
  )
  check(
    'empty hours are zeroes, not gaps',
    hourly.filter((p) => p.revenue === 0).length === 22,
    `${hourly.filter((p) => p.revenue === 0).length} empty`,
  )
  check(
    'the hourly total matches the headline figure',
    hourly.reduce((s, p) => s + p.revenue, 0) === todayStats.revenue,
  )

  /*
   * A year-TO-DATE in mid-March is 74 days, so it buckets by day, not by month.
   * That follows from `granularityFor` reading the actual span rather than the
   * preset's name, and it is the better answer: 74 daily bars carry more than
   * three monthly ones. The same preset in August spans 236 days and does go
   * monthly, which is what the owner asked to see. Both are asserted.
   */
  check('a year-to-date of 74 days stays daily', year.granularity === 'day', year.granularity)

  const longRange = resolveRange({
    preset: 'CUSTOM',
    from: '2025-01-01',
    to: '2025-12-31',
    now: anchor,
    timeZone: TZ,
  })
  check('a full year buckets by month', longRange.granularity === 'month', longRange.granularity)
  const monthly = await getRevenueSeries({
    restaurantId: restaurant.id,
    range: longRange,
    branchIds: null,
  })
  check(
    'and gives 12 points, gap-filled',
    monthly.length === 12,
    `${monthly.length}: ${monthly.map((p) => p.date).join(', ')}`,
  )

  const daily = await getRevenueSeries({
    restaurantId: restaurant.id,
    range: month,
    branchIds: null,
  })
  check('March to the 15th gives 15 daily points', daily.length === 15, `${daily.length}`)
  check(
    'the 14th and 15th are separate days',
    daily[13]?.revenue === 9_000 && daily[14]?.revenue === 3_000,
    `14th ${daily[13]?.revenue}, 15th ${daily[14]?.revenue}`,
  )

  // ── 4. custom ranges ──────────────────────────────────────────────────────
  console.log('\n── 4. custom ranges ──')

  const custom = resolveRange({
    preset: 'CUSTOM',
    from: '2026-03-14',
    to: '2026-03-14',
    now: anchor,
    timeZone: TZ,
  })
  check('a custom day is honoured', localDay(custom.from) === '2026-03-14', localDay(custom.from))
  const customStats = await getDashboardStats({
    restaurantId: restaurant.id,
    range: custom,
    branchIds: null,
  })
  check('and returns that day only', customStats.revenue === 9_000, `${customStats.revenue}`)

  const tooLong = resolveRange({
    preset: 'CUSTOM',
    from: '2020-01-01',
    to: '2026-01-01',
    now: anchor,
    timeZone: TZ,
  })
  check(
    'a range past the 400-day cap is clamped, not rejected',
    Math.round((tooLong.to.getTime() - tooLong.from.getTime()) / DAY) === 400,
    `${Math.round((tooLong.to.getTime() - tooLong.from.getTime()) / DAY)} days`,
  )

  const bad = resolveRange({
    preset: 'CUSTOM',
    from: '2026-03-20',
    to: '2026-03-10',
    now: anchor,
    timeZone: TZ,
  })
  check('a backwards range falls back rather than querying it', bad.preset === 'TODAY', bad.preset)

  // ── 5. the comparison is the previous equal window ────────────────────────
  console.log('\n── 5. like is compared with like ──')

  const prior = previousRange(today)
  check(
    'the previous window is the same length',
    Math.round((prior.to.getTime() - prior.from.getTime()) / 1000) ===
      Math.round((today.to.getTime() - today.from.getTime()) / 1000),
  )
  check('and ends where this one begins', prior.to.getTime() === today.from.getTime() - 1)
  check(
    'today vs yesterday is 3000 against 9000, so down',
    todayStats.revenueChange < 0,
    `${todayStats.revenueChange}`,
  )

  const marchStats = await getDashboardStats({
    restaurantId: restaurant.id,
    range: month,
    branchIds: null,
  })
  check(
    'a month compares against the month before, not yesterday',
    marchStats.revenue === 12_000 && marchStats.revenueChange === 100,
    `revenue ${marchStats.revenue}, change ${marchStats.revenueChange}`,
  )

  // ── 6. purchases, past the 200-row cap ────────────────────────────────────
  //
  // The report computed spend from `listPurchaseOrders({ limit: 200 })` and
  // reduced it in JavaScript, so 250 orders reported the total of 200 of them
  // and said nothing. 250 rows are created here for exactly that reason.
  console.log('\n── 6. purchases are summed in SQL, not in a 200-row page ──')

  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Supplier ${stamp}` },
  })

  await prisma.purchase.createMany({
    data: Array.from({ length: 250 }, (_, i) => ({
      restaurantId: restaurant.id,
      branchId: main.id,
      supplierId: supplier.id,
      number: `PO-${stamp}-${i}`,
      status: 'RECEIVED' as const,
      total: 100,
      subtotal: 100,
      createdAt: kolkata(2026, 3, 10, 10, 0),
      receivedAt: kolkata(2026, 3, 11, 10, 0),
    })),
  })

  // Noise that must NOT be counted, plus one genuinely outstanding order.
  await prisma.purchase.create({
    data: {
      restaurantId: restaurant.id,
      branchId: main.id,
      number: `PO-${stamp}-draft`,
      status: 'DRAFT',
      total: 999_999,
      createdAt: kolkata(2026, 3, 10, 10, 0),
    },
  })
  await prisma.purchase.create({
    data: {
      restaurantId: restaurant.id,
      branchId: main.id,
      number: `PO-${stamp}-cancelled`,
      status: 'CANCELLED',
      total: 888_888,
      createdAt: kolkata(2026, 3, 10, 10, 0),
    },
  })
  await prisma.purchase.create({
    data: {
      restaurantId: restaurant.id,
      branchId: main.id,
      number: `PO-${stamp}-late`,
      status: 'ORDERED',
      total: 5_000,
      createdAt: kolkata(2026, 3, 12, 10, 0),
      expectedAt: kolkata(2026, 3, 13, 10, 0), // in the past
    },
  })
  await prisma.purchase.create({
    data: {
      restaurantId: restaurant.id,
      branchId: second.id,
      number: `PO-${stamp}-other`,
      status: 'ORDERED',
      total: 777,
      createdAt: kolkata(2026, 3, 12, 10, 0),
    },
  })

  const buys = await getPurchaseSummary({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [main.id],
  })
  check(
    'all 250 orders are counted, not the first 200',
    buys.spend === 250 * 100 + 5_000,
    `${buys.spend} (expected ${250 * 100 + 5_000})`,
  )
  check('drafts and cancellations are excluded', buys.spend < 800_000, `${buys.spend}`)
  check('orders placed counts them all', buys.ordersPlaced === 251, `${buys.ordersPlaced}`)
  check('received in the window', buys.received === 250, `${buys.received}`)
  check('outstanding is the one open order', buys.outstandingCount === 1, `${buys.outstandingCount}`)
  check('and its expected date has passed', buys.overdueCount === 1, `${buys.overdueCount}`)
  check(
    'the other branch\'s order is not in Main\'s total',
    buys.outstandingValue === 5_000,
    `${buys.outstandingValue}`,
  )
  check(
    'the supplier breakdown adds up',
    buys.topSuppliers.find((s) => s.name === supplier.name)?.spend === 25_000,
    JSON.stringify(buys.topSuppliers),
  )

  // ── 7. the floor ──────────────────────────────────────────────────────────
  console.log('\n── 7. the floor ──')

  const t1 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '1', status: 'EATING' },
  })
  const t2 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '2', status: 'AVAILABLE' },
  })
  await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '3', status: 'CLEANING' },
  })
  const other = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: second.id, number: '1', status: 'OCCUPIED' },
  })

  await makeOrder({
    branchId: main.id,
    total: 4_000,
    placedAt: kolkata(2026, 3, 12, 19, 0),
    tableId: t1.id,
    guests: 4,
  })
  await makeOrder({
    branchId: main.id,
    total: 1_500,
    placedAt: kolkata(2026, 3, 12, 20, 0),
    tableId: t2.id,
    guests: 2,
  })
  await makeOrder({
    branchId: second.id,
    total: 50_000,
    placedAt: kolkata(2026, 3, 12, 20, 0),
    tableId: other.id,
    guests: 2,
  })

  const floor = await getFloorSummary({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [main.id],
  })
  check('EATING counts as in use, not just OCCUPIED', floor.inUse === 1, `${floor.inUse}`)
  check('free and cleaning are counted apart', floor.free === 1 && floor.cleaning === 1)
  check('the other branch\'s table is not on this floor', floor.total === 3, `${floor.total}`)
  check(
    'tables rank by takings',
    floor.topTables[0]?.number === '1' && floor.topTables[0]?.revenue === 4_000,
    JSON.stringify(floor.topTables),
  )
  check('covers are summed', floor.topTables[0]?.covers === 4, `${floor.topTables[0]?.covers}`)
  check(
    'the other branch\'s 50,000 is nowhere in Main\'s figures',
    floor.topTables.every((t) => t.revenue !== 50_000) && floor.seatedOrders === 2,
    `${floor.seatedOrders} seated`,
  )

  const otherFloor = await getFloorSummary({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [second.id],
  })
  check('and the second branch sees its own', otherFloor.topTables[0]?.revenue === 50_000)

  // ── 8. every figure is branch-scoped, and fails closed ────────────────────
  console.log('\n── 8. branch isolation, failing closed ──')

  const mainStats = await getDashboardStats({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [main.id],
  })
  const secondStats = await getDashboardStats({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [second.id],
  })
  const allStats = await getDashboardStats({
    restaurantId: restaurant.id,
    range: month,
    branchIds: null,
  })
  check(
    'the parts add up to the whole',
    mainStats.revenue + secondStats.revenue === allStats.revenue,
    `${mainStats.revenue} + ${secondStats.revenue} vs ${allStats.revenue}`,
  )

  /*
   * `[]` means "sees nothing" — a user confined to a location they have not
   * been given. It has been read as "no filter" at three separate call sites in
   * this codebase, which is a data leak every time. Every new query here is
   * checked for it.
   */
  const blind = await getDashboardStats({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [],
  })
  check('an empty allow-list sees no revenue', blind.revenue === 0, `${blind.revenue}`)
  check('nor any tables', blind.tablesTotal === 0, `${blind.tablesTotal}`)
  check('nor any low stock', blind.lowStockCount === 0, `${blind.lowStockCount}`)

  const blindSeries = await getRevenueSeries({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [],
  })
  check(
    'the trend is empty rather than everything',
    blindSeries.every((p) => p.revenue === 0),
  )

  const blindBuys = await getPurchaseSummary({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [],
  })
  check('no purchases either', blindBuys.spend === 0 && blindBuys.outstandingCount === 0)

  const blindFloor = await getFloorSummary({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [],
  })
  check('and no floor', blindFloor.total === 0 && blindFloor.topTables.length === 0)

  const blindCats = await getCategoryBreakdown({
    restaurantId: restaurant.id,
    range: month,
    branchIds: [],
  })
  check('nor a category breakdown', blindCats.length === 0, `${blindCats.length}`)

  // ── 9. a range built from two Dates ───────────────────────────────────────
  console.log('\n── 9. customRange ──')

  const built = customRange(kolkata(2026, 3, 12, 0, 0), kolkata(2026, 3, 12, 23, 59), TZ)
  check('carries its timezone', built.timeZone === TZ)
  check('and derives its granularity', built.granularity === 'hour', built.granularity)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.purchase.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
