/**
 * The switcher has to change the numbers.
 *
 * Before this, the top bar could name a location and not one figure beneath it
 * moved: `getDashboardStats` was a single raw query with eleven branch-less
 * subqueries, and the page-level loaders were all restaurant-wide. The control
 * looked like it worked, which is worse than not having it — an owner reads
 * "Kandy" at the top and the group's takings underneath, and prices a menu
 * against it.
 *
 * Two things are proved here, and the second matters more than the first:
 *
 *   1. Choosing a location returns that location's numbers, not the group's.
 *   2. Scoping fails CLOSED. A user confined to a location they have not been
 *      given sees nothing, never everything. `visibleBranchIds` returns `[]`
 *      for that person, and `[]` is falsy-looking enough that three separate
 *      call sites in this codebase had already read it as "no filter".
 *
 * Also covers the cache-key trap: the analytics helpers are wrapped in
 * `unstable_cache`, which keys on the array it is handed and cannot see the
 * closure. Filtering by branch while keying on the restaurant alone would serve
 * whichever location loaded first to every other one.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/branch-scope-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { getDashboardStats, getRevenueSeries } from '../src/features/analytics/queries'
import { getBranchStaffPerformance } from '../src/features/staff/performance'
import { customRange, resolveRange } from '../src/features/reports/range'
import { listOrders } from '../src/features/orders/queries'
import { getReorderSuggestions } from '../src/features/purchasing/suggestions'
import { scopeToOne } from '../src/features/dashboard/selected-branch'
import { visibleBranchIds } from '../src/lib/rbac'

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
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Scope ${stamp}`, slug: `scope-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const colombo = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'CMB', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })

  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Nimal',
      email: `nimal-${stamp}@example.com`,
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: kandy.id,
    },
  })

  // Colombo takes 3 orders worth 30,000; Kandy takes 1 worth 5,000.
  const makeOrder = (branchId: string, total: number, index: number) =>
    prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        branchId,
        orderNumber: `${stamp}-${index}`,
        customerName: 'Walk-in',
        customerPhone: '0770000000',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subtotal: total,
        grandTotal: total,
        paidTotal: total,
        placedAt: new Date(),
        createdById: branchId === kandy.id ? cashier.id : null,
      },
    })

  await makeOrder(colombo.id, 10_000, 1)
  await makeOrder(colombo.id, 10_000, 2)
  await makeOrder(colombo.id, 10_000, 3)
  await makeOrder(kandy.id, 5_000, 4)

  console.log('\n── the numbers follow the switcher ──')

  const statsRange = resolveRange({ preset: 'TODAY', timeZone: restaurant.timezone })
  const all = await getDashboardStats({ restaurantId: restaurant.id, range: statsRange })
  check('unfiltered shows every location', all.revenue === 35_000, `${all.revenue}`)

  const atColombo = await getDashboardStats({ restaurantId: restaurant.id, range: statsRange, branchIds: [colombo.id] })
  check('Colombo shows only Colombo', atColombo.revenue === 30_000, `${atColombo.revenue}`)
  check('and its order count too', atColombo.orders === 3, `${atColombo.orders}`)

  const atKandy = await getDashboardStats({ restaurantId: restaurant.id, range: statsRange, branchIds: [kandy.id] })
  check('Kandy shows only Kandy', atKandy.revenue === 5_000, `${atKandy.revenue}`)

  /*
   * The whole point. If these were ever equal, the branch predicate is missing
   * or — the subtler failure — the cache is serving one location's answer for
   * another.
   */
  check(
    'the two locations disagree',
    atColombo.revenue !== atKandy.revenue,
    'both returned the same figure, which means nothing is being filtered',
  )
  check(
    'and they sum to the group',
    atColombo.revenue + atKandy.revenue === all.revenue,
    `${atColombo.revenue} + ${atKandy.revenue} vs ${all.revenue}`,
  )

  console.log('\n── the same holds for the lists ──')

  const colomboOrders = await listOrders(restaurant.id, { branchId: colombo.id })
  const kandyOrders = await listOrders(restaurant.id, { branchId: kandy.id })
  const everyOrder = await listOrders(restaurant.id, {})
  check('order list narrows to Colombo', colomboOrders.total === 3, `${colomboOrders.total}`)
  check('order list narrows to Kandy', kandyOrders.total === 1, `${kandyOrders.total}`)
  check('and is whole when unfiltered', everyOrder.total === 4, `${everyOrder.total}`)

  const seriesRange = customRange(new Date(Date.now() - 86_400_000), new Date(Date.now() + 3_600_000))
  const colomboSeries = await getRevenueSeries({
    restaurantId: restaurant.id,
    range: seriesRange,
    branchIds: [colombo.id],
  })
  const kandySeries = await getRevenueSeries({
    restaurantId: restaurant.id,
    range: seriesRange,
    branchIds: [kandy.id],
  })
  check(
    'the trend chart is per location',
    colomboSeries.reduce((s: number, p) => s + p.revenue, 0) === 30_000 &&
      kandySeries.reduce((s: number, p) => s + p.revenue, 0) === 5_000,
    `${colomboSeries.reduce((s: number, p) => s + p.revenue, 0)} / ${kandySeries.reduce((s: number, p) => s + p.revenue, 0)}`,
  )

  const range = resolveRange({ preset: 'LAST_7', timeZone: 'UTC' })
  const staffAtKandy = await getBranchStaffPerformance({
    restaurantId: restaurant.id, branchIds: [kandy.id], range,
  })
  const staffAtColombo = await getBranchStaffPerformance({
    restaurantId: restaurant.id, branchIds: [colombo.id], range,
  })
  check(
    'staff figures are per location',
    staffAtKandy.rows.some((row) => row.userId === cashier.id) &&
      !staffAtColombo.rows.some((row) => row.userId === cashier.id),
    'the Kandy cashier appeared in Colombo’s league table',
  )
  check(
    'and the parts add up to the branch total',
    staffAtKandy.rows.reduce((sum, r) => sum + r.rungRevenue, 0) +
      staffAtKandy.unattributed.revenue === staffAtKandy.total.revenue,
    `${staffAtKandy.total.revenue}`,
  )

  console.log('\n── reorder suggestions read the shelf, not the item ──')

  /*
   * `getReorderSuggestions` used to filter on `InventoryItem.branchId` — the
   * item's notional home, which no screen writes, so it is null for every item.
   * Choosing a location returned nothing and the page said there was nothing to
   * buy. Items are restaurant-wide; it is the stock that lives somewhere.
   */
  const rice = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Rice',
      unit: 'KG',
      quantity: 60,
      reorderLevel: 20,
      costPerUnit: 250,
    },
  })
  await prisma.inventoryStock.create({
    data: { restaurantId: restaurant.id, itemId: rice.id, branchId: colombo.id, available: 55 },
  })
  await prisma.inventoryStock.create({
    data: { restaurantId: restaurant.id, itemId: rice.id, branchId: kandy.id, available: 5 },
  })

  const groupWide = await getReorderSuggestions({ restaurantId: restaurant.id })
  check(
    'the group is not short (60kg against a floor of 20)',
    !groupWide.some((s) => s.itemId === rice.id),
    'suggested a reorder the restaurant does not need',
  )

  const kandyNeeds = await getReorderSuggestions({ restaurantId: restaurant.id, branchId: kandy.id })
  const kandyRice = kandyNeeds.find((s) => s.itemId === rice.id)
  check('but Kandy is (5kg against 20)', Boolean(kandyRice), 'missed a location that is genuinely short')
  check('and it counts what Kandy actually holds', kandyRice?.currentQty === 5, `${kandyRice?.currentQty}`)

  const colomboNeeds = await getReorderSuggestions({
    restaurantId: restaurant.id,
    branchId: colombo.id,
  })
  check(
    'while Colombo is not',
    !colomboNeeds.some((s) => s.itemId === rice.id),
    'told a location with 55kg to order more',
  )

  console.log('\n── and it fails closed ──')

  const groupManager = visibleBranchIds({ role: 'MANAGER', branchId: null })
  const siteManager = visibleBranchIds({ role: 'MANAGER', branchId: kandy.id })
  const unassigned = visibleBranchIds({ role: 'CASHIER', branchId: null })

  check('a group manager is unrestricted', groupManager === null)
  check('a site manager gets their one location', siteManager?.length === 1 && siteManager[0] === kandy.id)
  check('an unassigned confined user gets an empty list', Array.isArray(unassigned) && unassigned.length === 0)

  /*
   * `[]` must mean "sees nothing". Read as "no filter" — which is what a plain
   * `ids.length === 1 ? ids[0] : null` does — an unassigned warehouse worker
   * saw every transfer in the restaurant. `scopeToOne` returns an id that
   * cannot match, so the query returns nothing.
   */
  const confined = scopeToOne({ branchId: null, branchIds: [], confinedWithNoBranch: true })
  check('scopeToOne refuses to widen it', confined !== null, 'returned null, which means "everything"')

  const nothing = await listOrders(restaurant.id, { branchId: confined })
  check('so their order list is empty, not complete', nothing.total === 0, `${nothing.total} orders leaked`)

  const noFigures = await getDashboardStats({ restaurantId: restaurant.id, range: statsRange, branchIds: confined ? [confined] : [] })
  check('and their dashboard is zero, not the group total', noFigures.revenue === 0, `${noFigures.revenue}`)

  // A user with one location resolves to that location even with nothing chosen.
  check(
    'one visible location needs no choosing',
    scopeToOne({ branchId: null, branchIds: [kandy.id], confinedWithNoBranch: false }) === kandy.id,
  )
  check(
    'and an unrestricted user with no choice stays unrestricted',
    scopeToOne({ branchId: null, branchIds: null, confinedWithNoBranch: false }) === null,
  )

  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
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
