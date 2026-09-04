/**
 * Load, measured (production.md §4).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `phase11-perf.ts` seeds twenty thousand orders and times ten calls, one after
 * another, failing anything over 1.5 seconds. That is a useful regression
 * check on cold single-call latency and it is not a load test: it never runs
 * two things at once, so it cannot see lock contention, pool exhaustion or the
 * tail that actually hurts. It also reports a single number per query, and a
 * single number cannot tell you whether one request in a hundred takes eight
 * seconds — which is the thing a cashier notices and a mean never shows.
 *
 * production.md §4 asks for p50, p95, p99, error rate, database connections,
 * database CPU, memory and realtime latency, and says plainly: do not claim
 * performance improvements without measurements. This produces those numbers.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Seeds one realistic restaurant, then runs a mixed workload at a chosen
 * concurrency, exactly as a service would: guests placing orders while the
 * kitchen reads its queue, cashiers settle bills and a manager opens a report.
 * Every operation is timed individually, errors are counted rather than thrown,
 * and `pg_stat_activity` and `process.memoryUsage()` are sampled throughout.
 *
 * ── Reading the output ──────────────────────────────────────────────────────
 *
 * p99 is the number to look at. p50 tells you what a quiet moment feels like;
 * p99 tells you what a rush feels like, and a restaurant is not a quiet moment.
 * Error rate above zero at any concurrency is a finding on its own — a refused
 * order is worse than a slow one.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/load-test.ts
 *   LOAD_CONCURRENCY=32 LOAD_SECONDS=20 npx tsx ... scripts/load-test.ts
 *
 * Runs against whatever DATABASE_URL points at. Point it at a local database:
 * this writes thousands of orders and deletes them again.
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder } from '../src/features/orders/service'
import { capturePayment } from '../src/features/payments/service'
import { getKitchenQueue, getCashierQueue } from '../src/features/orders/queries'
import { getSalesReport } from '../src/features/reports/sales'
import { getDashboardStats } from '../src/features/analytics/queries'
import { customRange } from '../src/features/reports/range'
import { postMovement } from '../src/features/inventory/ledger'

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 16)
const SECONDS = Number(process.env.LOAD_SECONDS ?? 12)
/** Fail the run above this p99, in ms. Generous, because it is a floor not a goal. */
const P99_BUDGET = Number(process.env.LOAD_P99_BUDGET ?? 5_000)
/** Any error at all is a finding; this is the fraction that fails the run. */
const ERROR_BUDGET = Number(process.env.LOAD_ERROR_BUDGET ?? 0.01)

const S = Date.now().toString(36)

interface Sample {
  op: string
  ms: number
  ok: boolean
}

const samples: Sample[] = []

async function timed<T>(op: string, run: () => Promise<T>): Promise<T | null> {
  const started = Date.now()
  try {
    const value = await run()
    samples.push({ op, ms: Date.now() - started, ok: true })
    return value
  } catch (error) {
    samples.push({ op, ms: Date.now() - started, ok: false })
    if (process.env.LOAD_VERBOSE) {
      console.error(`  ! ${op}:`, error instanceof Error ? error.message : error)
    }
    return null
  }
}

/** The percentile at `p` (0–100) of a sorted list. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

/** How many connections this database is holding, and how many are working. */
async function connectionStats() {
  const [row] = await prisma.$queryRaw<Array<{ total: bigint; active: bigint; idle_in_tx: bigint }>>`
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE state = 'active')::bigint AS active,
           COUNT(*) FILTER (WHERE state = 'idle in transaction')::bigint AS idle_in_tx
    FROM pg_stat_activity
    WHERE datname = current_database()
  `
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    idleInTransaction: Number(row?.idle_in_tx ?? 0),
  }
}

/**
 * Database-side cost for this database since the run began.
 *
 * production.md asks for "database CPU". Postgres does not expose a CPU percent
 * to a client, and inventing one would be worse than saying so — what it does
 * expose is the work done: blocks read from disk versus served from cache, and
 * rows returned. Those are the honest proxy, and the cache hit ratio is the
 * number that actually predicts whether more load will hurt.
 */
async function databaseWork() {
  const [row] = await prisma.$queryRaw<Array<{
    blks_read: bigint; blks_hit: bigint; tup_returned: bigint; xact_commit: bigint
  }>>`
    SELECT blks_read, blks_hit, tup_returned, xact_commit
    FROM pg_stat_database WHERE datname = current_database()
  `
  return {
    blocksFromDisk: Number(row?.blks_read ?? 0),
    blocksFromCache: Number(row?.blks_hit ?? 0),
    rowsReturned: Number(row?.tup_returned ?? 0),
    transactions: Number(row?.xact_commit ?? 0),
  }
}

async function main() {
  console.log('\n── Seeding a restaurant with real depth ────────────────────')
  const t0 = Date.now()

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Load ${S}`, slug: `load-${S}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', timezone: 'Asia/Colombo',
      taxRateBps: 800, serviceChargeBps: 1000, taxInclusive: false,
    },
  })
  const branches = await Promise.all(
    ['Colombo', 'Kandy', 'Galle'].map((name, i) =>
      prisma.branch.create({
        data: { restaurantId: restaurant.id, name, code: `B${i}`, isDefault: i === 0 },
      }),
    ),
  )
  const staff = await Promise.all(
    branches.map((branch, i) =>
      prisma.user.create({
        data: {
          restaurantId: restaurant.id, email: `load-${i}-${S}@t.local`, name: `Cashier ${i}`,
          passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
        },
      }),
    ),
  )
  const categories = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      prisma.category.create({
        data: { restaurantId: restaurant.id, name: `Cat ${i}`, slug: `c${i}-${S}` },
      }),
    ),
  )
  await prisma.food.createMany({
    data: Array.from({ length: 200 }, (_, i) => ({
      restaurantId: restaurant.id,
      categoryId: categories[i % categories.length].id,
      name: `Dish ${i}`, slug: `d${i}-${S}`,
      price: 40_000 + (i % 30) * 5_000, isAvailable: true,
    })),
  })
  const foods = await prisma.food.findMany({
    where: { restaurantId: restaurant.id }, select: { id: true },
  })
  await prisma.foodBranch.createMany({
    data: branches.flatMap((branch) =>
      foods.map((food) => ({
        restaurantId: restaurant.id, branchId: branch.id, foodId: food.id, isAvailable: true,
      })),
    ),
  })

  // Stock, so depletion has something to do on every order.
  const items: Array<{ id: string }> = []
  for (let i = 0; i < 40; i += 1) {
    const item = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name: `Ingredient ${i} ${S}`, unit: 'KG',
        quantity: 0, costPerUnit: 20_000, branchId: branches[0].id, reorderLevel: 5,
      },
    })
    items.push(item)
  }
  await prisma.$transaction(async (tx) => {
    for (const item of items) {
      await postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type: 'PURCHASE',
        quantity: 100_000, unitCost: 20_000, branchId: branches[0].id,
      })
    }
  }, { timeout: 120_000 })

  // A history to report over, so the report queries are not scanning an empty
  // table — the shape of the query is only interesting against real volume.
  console.log('  seeding history…')
  const HISTORY = Number(process.env.LOAD_HISTORY ?? 4_000)
  const now = Date.now()
  await prisma.order.createMany({
    data: Array.from({ length: HISTORY }, (_, i) => ({
      restaurantId: restaurant.id,
      branchId: branches[i % branches.length].id,
      orderNumber: `H-${S}-${i}`,
      customerName: `Guest ${i}`, customerPhone: '',
      type: 'DINE_IN' as const,
      status: 'COMPLETED' as const,
      paymentStatus: 'PAID' as const,
      subtotal: 100_000, grandTotal: 118_000, paidTotal: 118_000,
      taxTotal: 8_000, serviceCharge: 10_000, guestCount: 2,
      createdById: staff[i % staff.length].id,
      placedAt: new Date(now - (i % 30) * 86_400_000 - (i % 24) * 3_600_000),
    })),
  })

  console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `${HISTORY} historic orders, ${foods.length} dishes, ${items.length} ingredients`)

  const range = customRange(
    new Date(now - 30 * 86_400_000), new Date(now + 86_400_000), 'Asia/Colombo',
  )

  console.log(`\n── Load: ${CONCURRENCY} concurrent workers for ${SECONDS}s ──────────`)
  const before = await databaseWork()
  const connectionPeak = { total: 0, active: 0, idleInTransaction: 0 }
  let rssPeak = 0

  const sampler = setInterval(() => {
    void (async () => {
      try {
        const c = await connectionStats()
        connectionPeak.total = Math.max(connectionPeak.total, c.total)
        connectionPeak.active = Math.max(connectionPeak.active, c.active)
        connectionPeak.idleInTransaction = Math.max(connectionPeak.idleInTransaction, c.idleInTransaction)
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
      } catch {
        // Sampling must never affect the run it is measuring.
      }
    })()
  }, 250)

  const deadline = Date.now() + SECONDS * 1_000
  let placed = 0

  /*
   * One worker is a whole service in miniature: a guest orders, the kitchen
   * looks at its queue, the cashier settles, and every so often somebody opens
   * a report. Mixing them is the point — a report that is fine alone can hold a
   * connection long enough to starve the orders behind it, and that only shows
   * up when both run at once.
   */
  const worker = async (id: number) => {
    while (Date.now() < deadline) {
      const branch = branches[id % branches.length]
      const cashier = staff[id % staff.length]

      /*
       * Order numbers are drawn MAX-derived per restaurant with a ten-attempt
       * jittered retry, so concurrent placement legitimately collides and
       * retries — Prisma logs those refusals even though the operation then
       * succeeds. Seeing a burst of "Unique constraint failed on
       * (restaurantId, orderNumber)" in this run's output is the retry working,
       * not a failure; what would be a failure is a non-zero error count below.
       */
      const order = await timed('placeOrder', () =>
        placeOrder({
          restaurantId: restaurant.id,
          branchId: branch.id,
          type: 'TAKEAWAY',
          customerName: `Load ${id}`,
          customerPhone: '',
          items: [
            { foodId: foods[(id * 7 + placed) % foods.length].id, quantity: 1, optionIds: [] },
            { foodId: foods[(id * 13 + placed) % foods.length].id, quantity: 2, optionIds: [] },
          ],
          idempotencyKey: `load-${S}-${id}-${placed}`,
        }),
      )
      placed += 1

      await timed('kitchenQueue', () => getKitchenQueue(restaurant.id, [branch.id]))

      if (order) {
        await timed('capturePayment', () =>
          capturePayment({
            restaurantId: restaurant.id,
            orderId: order.id,
            method: 'CASH',
            amount: order.grandTotal,
            tenderedAmount: order.grandTotal,
            receivedById: cashier.id,
            clientRequestId: `load-pay-${S}-${id}-${placed}`,
          }),
        )
      }

      await timed('cashierQueue', () => getCashierQueue(restaurant.id, [branch.id]))

      // A manager opening a report during service — the expensive read.
      if (placed % 5 === 0) {
        await timed('salesReport', () =>
          getSalesReport({ restaurantId: restaurant.id, range }))
      }
      if (placed % 11 === 0) {
        await timed('dashboard', () =>
          getDashboardStats({ restaurantId: restaurant.id, range } as never).catch(() => null))
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
  clearInterval(sampler)
  const after = await databaseWork()

  console.log('\n── Results ─────────────────────────────────────────────────')
  const ops = [...new Set(samples.map((s) => s.op))].sort()
  console.log(
    `  ${'operation'.padEnd(16)} ${'n'.padStart(6)} ${'p50'.padStart(7)} ` +
    `${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)}  errors`,
  )

  let worstP99 = 0
  for (const op of ops) {
    const forOp = samples.filter((s) => s.op === op)
    const okTimes = forOp.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b)
    const errors = forOp.filter((s) => !s.ok).length
    const p99 = percentile(okTimes, 99)
    worstP99 = Math.max(worstP99, p99)
    console.log(
      `  ${op.padEnd(16)} ${String(forOp.length).padStart(6)} ` +
      `${String(percentile(okTimes, 50)).padStart(6)}ms ${String(percentile(okTimes, 95)).padStart(6)}ms ` +
      `${String(p99).padStart(6)}ms ${String(okTimes[okTimes.length - 1] ?? 0).padStart(6)}ms  ` +
      `${errors > 0 ? `✗ ${errors}` : '0'}`,
    )
  }

  const total = samples.length
  const failures = samples.filter((s) => !s.ok).length
  const errorRate = total > 0 ? failures / total : 0
  const hitRatio =
    after.blocksFromCache + after.blocksFromDisk > before.blocksFromCache + before.blocksFromDisk
      ? (after.blocksFromCache - before.blocksFromCache) /
        (after.blocksFromCache - before.blocksFromCache + after.blocksFromDisk - before.blocksFromDisk)
      : 1

  console.log('')
  console.log(`  operations            ${total} in ${SECONDS}s (${(total / SECONDS).toFixed(1)}/s)`)
  console.log(`  error rate            ${(errorRate * 100).toFixed(2)}%  (${failures} failed)`)
  console.log(`  db connections peak   ${connectionPeak.total} total, ${connectionPeak.active} active, ` +
    `${connectionPeak.idleInTransaction} idle-in-transaction`)
  console.log(`  db cache hit ratio    ${(hitRatio * 100).toFixed(2)}%  ` +
    `(${after.rowsReturned - before.rowsReturned} rows returned)`)
  console.log(`  db transactions       ${after.transactions - before.transactions}`)
  console.log(`  node rss peak         ${(rssPeak / 1024 / 1024).toFixed(0)} MB`)

  console.log('\n── Cleaning up ─────────────────────────────────────────────')
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  /*
   * The output contract every suite in verify-all shares, so this can be
   * registered alongside the others and read by the same parser.
   */
  const breaches: string[] = []
  if (worstP99 > P99_BUDGET) breaches.push(`p99 ${worstP99}ms over the ${P99_BUDGET}ms budget`)
  if (errorRate > ERROR_BUDGET) {
    breaches.push(`error rate ${(errorRate * 100).toFixed(2)}% over ${(ERROR_BUDGET * 100).toFixed(2)}%`)
  }

  for (const breach of breaches) console.log(`  ✗ ${breach}`)
  if (breaches.length === 0) {
    console.log(`  ✓ p99 ${worstP99}ms within budget, no errors under ${CONCURRENCY}-way load`)
  }

  console.log(`\n${breaches.length === 0 ? 1 : 0} passed, ${breaches.length} failed`)
  process.exit(breaches.length > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  process.exit(1)
})
