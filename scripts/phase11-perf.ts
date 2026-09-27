/** Phase 11: performance against a realistic data volume. */
import { prisma } from '../src/server/db/prisma'
import { getSalesReport } from '../src/features/reports/sales'
import { getProfitReport } from '../src/features/reports/profit'
import { resolveRange } from '../src/features/reports/range'
import { getDashboardStats } from '../src/features/analytics/queries'
import { listStockAlerts, getInventorySummary } from '../src/features/inventory/alerts'
import { accountBalances } from '../src/features/payments/accounts-ledger'
import { seedDefaultAccounts } from '../src/features/payments/accounts'

const S = Date.now().toString(36)
const shops: string[] = []

/**
 * How many sequential scans each table has taken, and how many rows they read.
 *
 * Timings say a query is slow. They do not say why, and at development
 * volumes a full scan of a small table is fast — so a plan that will not
 * survive production looks perfectly healthy. Postgres counts scans per
 * table, so the difference across a workload says which tables were read end
 * to end and how many rows that cost, whatever the clock said.
 *
 * This is measurement rather than inspection: no query shapes are written
 * down here, so nothing drifts when a report is rewritten. If a loader starts
 * scanning `orders`, this notices without being told the loader exists.
 */
async function scanCounters(): Promise<Map<string, { seq: number; rows: number; idx: number }>> {
  const rows = await prisma.$queryRaw<
    Array<{ relname: string; seq_scan: bigint; seq_tup_read: bigint; idx_scan: bigint | null }>
  >`
    SELECT relname, seq_scan, seq_tup_read, idx_scan
      FROM pg_stat_user_tables
  `
  return new Map(
    rows.map((row) => [
      row.relname,
      { seq: Number(row.seq_scan), rows: Number(row.seq_tup_read), idx: Number(row.idx_scan ?? 0) },
    ]),
  )
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<number> {
  const t = Date.now()
  await fn()
  const ms = Date.now() - t
  const flag = ms > 1500 ? '  ⚠ SLOW' : ms > 500 ? '  ·' : '  ✓'
  console.log(`${flag} ${label.padEnd(44)} ${String(ms).padStart(6)}ms`)
  return ms
}

async function main() {
  console.log('\n── Seeding ──────────────────────────────────────────────')
  const t0 = Date.now()

  // One realistic restaurant with real depth, plus neighbours so every query
  // has to actually discriminate by tenant rather than reading an empty table.
  const shop = await prisma.restaurant.create({
    data: { name: `Perf ${S}`, slug: `perf-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shop.id)

  const branches = await Promise.all(
    ['Colombo', 'Kandy', 'Galle', 'Warehouse', 'Production'].map((n, i) =>
      prisma.branch.create({
        data: {
          restaurantId: shop.id, name: n, code: `B${i}`, isDefault: i === 0,
          type: i === 3 ? 'CENTRAL_WAREHOUSE' : i === 4 ? 'PRODUCTION_HOUSE' : 'BRANCH',
        },
      }),
    ),
  )

  const cats = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      prisma.category.create({ data: { restaurantId: shop.id, name: `Cat${i}`, slug: `c${i}-${S}` } }),
    ),
  )

  await prisma.food.createMany({
    data: Array.from({ length: 1000 }, (_, i) => ({
      restaurantId: shop.id, categoryId: cats[i % cats.length].id,
      name: `Dish ${i}`, slug: `dish-${i}-${S}`, price: 500_00 + (i % 40) * 25_00,
    })),
  })
  const foods = await prisma.food.findMany({ where: { restaurantId: shop.id }, select: { id: true, price: true } })

  await prisma.inventoryItem.createMany({
    data: Array.from({ length: 400 }, (_, i) => ({
      restaurantId: shop.id, name: `Ingredient ${i}`, unit: 'KG' as const,
      costPerUnit: 100_00 + i, reorderLevel: 20, quantity: i % 30,
      branchId: branches[i % 3].id,
    })),
  })
  const items = await prisma.inventoryItem.findMany({ where: { restaurantId: shop.id }, select: { id: true } })

  // 5,000 stock movements.
  await prisma.stockMovement.createMany({
    data: Array.from({ length: 5000 }, (_, i) => ({
      restaurantId: shop.id, itemId: items[i % items.length].id,
      branchId: branches[i % 3].id, type: i % 4 === 0 ? 'PURCHASE' as const : 'SALE' as const,
      quantity: i % 4 === 0 ? 10 : -2, balanceAfter: 100 - (i % 50),
      createdAt: new Date(Date.now() - (i % 90) * 86_400_000),
    })),
  })

  /*
   * 20,000 orders with 60,000 lines by default — enough that an unindexed scan
   * hurts, and small enough to stay in the gate's budget.
   *
   * `PERF_ORDERS` raises it for a deliberate capacity run: `PERF_ORDERS=100000`
   * is the "twenty restaurants, a hundred thousand records each" question,
   * asked of the tenant that has them, because a query that discriminates by
   * restaurant is only tested by a big table it has to discriminate against.
   */
  const ORDERS = Number(process.env.PERF_ORDERS ?? 20_000)
  const BATCH = 2000
  for (let b = 0; b < ORDERS / BATCH; b++) {
    await prisma.order.createMany({
      data: Array.from({ length: BATCH }, (_, k) => {
        const i = b * BATCH + k
        return {
          restaurantId: shop.id, branchId: branches[i % 3].id,
          orderNumber: `O-${S}-${i}`, type: 'DINE_IN' as const,
          status: 'COMPLETED' as const, paymentStatus: 'PAID' as const,
          customerName: 'Guest', customerPhone: '07',
          subtotal: 2_000_00, taxTotal: 100_00, serviceCharge: 50_00,
          grandTotal: 2_150_00, paidTotal: 2_150_00, guestCount: 2,
          placedAt: new Date(Date.now() - (i % 60) * 86_400_000 - (i % 24) * 3_600_000),
        }
      }),
    })
  }
  const orderIds = await prisma.order.findMany({
    where: { restaurantId: shop.id }, select: { id: true }, take: ORDERS,
  })
  for (let b = 0; b < orderIds.length; b += BATCH) {
    const slice = orderIds.slice(b, b + BATCH)
    await prisma.orderItem.createMany({
      data: slice.flatMap((o, k) =>
        Array.from({ length: 3 }, (_, j) => {
          const f = foods[(b + k + j) % foods.length]
          return {
            orderId: o.id, foodId: f.id, name: `Dish ${(b + k + j) % 1000}`,
            unitPrice: f.price, quantity: 1, lineTotal: f.price, costPrice: Math.round(f.price * 0.35),
          }
        }),
      ),
    })
  }

  /*
   * A payment per order, spread over the accounts, because an internal
   * account's balance is DERIVED from these rows (bank.md: there is no balance
   * column) — so "what does BOC hold" is an aggregate over the payments table,
   * and it is only measured by a payments table with something in it.
   */
  // Created straight through Prisma rather than by registering, so it has none.
  await seedDefaultAccounts(prisma, shop.id)
  const accounts = await prisma.paymentAccount.findMany({
    where: { restaurantId: shop.id },
    select: { code: true },
    orderBy: { code: 'asc' },
  })
  if (accounts.length > 0) {
    for (let b = 0; b < orderIds.length; b += BATCH) {
      const slice = orderIds.slice(b, b + BATCH)
      await prisma.payment.createMany({
        data: slice.map((o, k) => {
          const i = b + k
          return {
            restaurantId: shop.id,
            orderId: o.id,
            method: (i % 3 === 0 ? 'CARD' : 'CASH') as 'CARD' | 'CASH',
            status: 'PAID' as const,
            amount: 2_150_00,
            destination: accounts[i % accounts.length].code,
            paidAt: new Date(Date.now() - (i % 60) * 86_400_000),
          }
        }),
      })
    }
  }

  const counts = {
    orders: await prisma.order.count({ where: { restaurantId: shop.id } }),
    lines: await prisma.orderItem.count({ where: { order: { restaurantId: shop.id } } }),
    movements: await prisma.stockMovement.count({ where: { restaurantId: shop.id } }),
    payments: await prisma.payment.count({ where: { restaurantId: shop.id } }),
    accounts: accounts.length,
    foods: foods.length,
    items: items.length,
  }
  console.log(`  seeded in ${Math.round((Date.now() - t0) / 1000)}s:`,
    `${counts.orders} orders, ${counts.lines} lines, ${counts.movements} movements,`,
    `${counts.payments} payments over ${counts.accounts} accounts,`,
    `${counts.foods} dishes, ${counts.items} ingredients, ${branches.length} locations`)

  console.log('\n── Query timings (⚠ = over 1.5s) ────────────────────────')
  const month = resolveRange({ preset: 'THIS_MONTH' })
  const wide = resolveRange({ preset: 'LAST_30' })

  const scansBefore = await scanCounters()

  const timings: number[] = []
  timings.push(await timed('dashboard stats', () => getDashboardStats({ restaurantId: shop.id, range: resolveRange({ preset: 'TODAY' }) })))
  timings.push(await timed('sales report — this month', () => getSalesReport({ restaurantId: shop.id, range: month })))
  timings.push(await timed('sales report — one branch', () => getSalesReport({ restaurantId: shop.id, range: month, branchIds: [branches[0].id] })))
  timings.push(await timed('gross profit — last 30 days', () => getProfitReport({ restaurantId: shop.id, range: wide })))
  timings.push(await timed('stock alerts', () => listStockAlerts({ restaurantId: shop.id })))
  timings.push(await timed('inventory summary', () => getInventorySummary({ restaurantId: shop.id })))
  timings.push(await timed('order list page 1 (paginated)', () =>
    prisma.order.findMany({ where: { restaurantId: shop.id }, orderBy: { placedAt: 'desc' }, take: 25,
      include: { items: { select: { id: true } } } })))
  timings.push(await timed('order list page 200 (deep offset)', () =>
    prisma.order.findMany({ where: { restaurantId: shop.id }, orderBy: { placedAt: 'desc' }, skip: 5000, take: 25 })))
  timings.push(await timed('ledger for one item', () =>
    prisma.stockMovement.findMany({ where: { restaurantId: shop.id, itemId: items[0].id },
      orderBy: { createdAt: 'desc' }, take: 200 })))
  timings.push(await timed('branch-scoped movements', () =>
    prisma.stockMovement.findMany({ where: { restaurantId: shop.id, branchId: branches[0].id },
      orderBy: { createdAt: 'desc' }, take: 100 })))

  /*
   * The derived-balance question. Every internal account's balance is five
   * aggregates over the payments, refunds and entries tables (bank.md: no
   * balance column, so nothing can drift), which means the Payment Details
   * screen's cost grows with the payments table. This is the number that says
   * whether that matters — and it says it does not: 42ms at 100,000 payments.
   *
   * Measured because a cache was once put here on the assumption that it was
   * slow. It was not, and the cache made an account's balance disagree with its
   * own history for fifteen seconds after every sale.
   */
  timings.push(await timed('account balances — all accounts', () =>
    accountBalances(prisma, shop.id)))

  /*
   * The customers tab, which shows what each customer owes — a per-row sum
   * over their unpaid orders. The column the owner asked for, at volume.
   */
  timings.push(await timed('customer list with amount owed', () =>
    prisma.customer.findMany({ where: { restaurantId: shop.id }, take: 50,
      orderBy: { createdAt: 'desc' } })))
  timings.push(await timed('payments list page 1', () =>
    prisma.payment.findMany({ where: { restaurantId: shop.id }, orderBy: { createdAt: 'desc' },
      take: 25 })))

  const slow = timings.filter((t) => t > 1500).length
  console.log(`\n  slowest ${Math.max(...timings)}ms · ${slow} over 1.5s`)

  /*
   * Which tables that workload read end to end.
   *
   * A sequential scan is not automatically wrong — Postgres rightly prefers
   * one over an index for a small table, and reading 40 rows of `branches` is
   * cheaper than descending a btree. What matters is rows read PER scan on a
   * table that grows: that number is what multiplies as the restaurant trades.
   */
  console.log('\n── Sequential scans during that workload ────────────────')
  const scansAfter = await scanCounters()
  const scanned: Array<{ table: string; scans: number; rows: number; perScan: number }> = []
  for (const [table, after] of scansAfter) {
    const before = scansBefore.get(table) ?? { seq: 0, rows: 0, idx: 0 }
    const scans = after.seq - before.seq
    const rows = after.rows - before.rows
    if (scans > 0 && rows > 0) scanned.push({ table, scans, rows, perScan: Math.round(rows / scans) })
  }
  scanned.sort((a, b) => b.perScan - a.perScan)

  if (scanned.length === 0) {
    console.log('  ✓ none — every query used an index')
  } else {
    for (const row of scanned.slice(0, 12)) {
      const flag = row.perScan > 10_000 ? '  ⚠' : row.perScan > 1_000 ? '  ·' : '  ✓'
      console.log(
        `${flag} ${row.table.padEnd(30)} ${String(row.scans).padStart(4)} scan(s), ` +
        `${String(row.perScan).padStart(8)} rows each`,
      )
    }
    const heavy = scanned.filter((row) => row.perScan > 10_000)
    if (heavy.length > 0) {
      console.log(
        `\n  ⚠ ${heavy.length} table(s) read more than 10,000 rows per scan: ` +
        `${heavy.map((row) => row.table).join(', ')}`,
      )
      console.log('    At this dataset that is survivable. It is the number that grows.')
    }
  }

  console.log('\n── Cleanup ──────────────────────────────────────────────')
  await prisma.payment.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.paymentAccountEntry.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.paymentAccount.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: shop.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.food.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.category.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.deleteMany({ where: { id: { in: shops } } })
  console.log('  removed')

  await prisma.$disconnect()
  process.exit(slow > 0 ? 1 : 0)
}

main().catch(async (e) => { console.error('CRASHED:', e); await prisma.$disconnect(); process.exit(1) })
