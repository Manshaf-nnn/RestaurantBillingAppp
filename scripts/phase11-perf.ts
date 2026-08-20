/** Phase 11: performance against a realistic data volume. */
import { prisma } from '../src/server/db/prisma'
import { getSalesReport } from '../src/features/reports/sales'
import { getProfitReport } from '../src/features/reports/profit'
import { resolveRange } from '../src/features/reports/range'
import { getDashboardStats } from '../src/features/analytics/queries'
import { listStockAlerts, getInventorySummary } from '../src/features/inventory/alerts'

const S = Date.now().toString(36)
const shops: string[] = []

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

  // 20,000 orders with 60,000 lines. Enough that an unindexed scan hurts.
  const ORDERS = 20_000
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

  const counts = {
    orders: await prisma.order.count({ where: { restaurantId: shop.id } }),
    lines: await prisma.orderItem.count({ where: { order: { restaurantId: shop.id } } }),
    movements: await prisma.stockMovement.count({ where: { restaurantId: shop.id } }),
    foods: foods.length,
    items: items.length,
  }
  console.log(`  seeded in ${Math.round((Date.now() - t0) / 1000)}s:`,
    `${counts.orders} orders, ${counts.lines} lines, ${counts.movements} movements,`,
    `${counts.foods} dishes, ${counts.items} ingredients, ${branches.length} locations`)

  console.log('\n── Query timings (⚠ = over 1.5s) ────────────────────────')
  const month = resolveRange({ preset: 'THIS_MONTH' })
  const wide = resolveRange({ preset: 'LAST_30' })

  const timings: number[] = []
  timings.push(await timed('dashboard stats', () => getDashboardStats(shop.id)))
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

  const slow = timings.filter((t) => t > 1500).length
  console.log(`\n  slowest ${Math.max(...timings)}ms · ${slow} over 1.5s`)

  console.log('\n── Cleanup ──────────────────────────────────────────────')
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
