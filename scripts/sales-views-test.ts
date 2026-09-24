/**
 * The sales report shows one breakdown at a time, and an item opens its bills.
 *
 * ── What changed and why it needs pinning ──────────────────────────────────
 *
 * The page stacked seven tables and computed all of them on every load. They
 * are a choice now, carried in `?view=`. Two things can silently regress:
 *
 *   1. a view leaking — two tables rendering at once, which is the old page
 *      creeping back one `&&` at a time;
 *   2. the item drill-down claiming more than the schema knows.
 *
 * (2) is the one that matters. There is no link from a payment to a line:
 * `Payment.orderId` is the only join, and no allocation table exists. So the
 * drill-down can only honestly report the BILLS an item was on and what was
 * paid against those bills. Anything that divides a payment across the lines
 * of its bill is inventing a figure, and this test exists to make that
 * invention fail loudly rather than ship looking precise.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/sales-views-test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { getItemPaymentDetail } from '../src/features/reports/sales'
import { resolveRange } from '../src/features/reports/range'

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

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

  /* ── 1. One breakdown at a time ─────────────────────────────────────────── */
  console.log('\n1. The page renders the breakdown that was asked for')

  const page = read('src/app/dashboard/reports/sales/page.tsx')
  for (const view of ['summary', 'item', 'category', 'day', 'hour', 'payment', 'staff', 'location']) {
    check(`?view=${view} is offered and gated`, page.includes(`view === '${view}'`) || view === 'summary')
  }
  check('the view comes from the URL', page.includes("str('view')"))
  check(
    'and only the payment breakdown is loaded when a view needs it',
    page.includes('needsPayments'),
    'Loading all seven queries for one table is what this change was about.',
  )
  check('the totals are outside the switch, on every view', /StatCard label="Gross sales"/.test(page))
  check(
    'the hour table says it is hour-of-day across the period',
    page.includes('added up across the whole period'),
    'Read as "7pm on one date" a week looks like one very busy evening.',
  )
  check('an item row links to its own drill-down', page.includes('hrefTemplate={itemHref}'))
  check('and the drill-down keeps the period and the location', /for \(const key of \['preset', 'from', 'to', 'branch'\]\)/.test(page))

  /* ── 2. The honest join ─────────────────────────────────────────────────── */
  console.log('\n2. A payment settles a bill, and the screen says so')

  const sales = read('src/features/reports/sales.ts')
  check('getItemPaymentDetail exists', sales.includes('export async function getItemPaymentDetail'))
  check(
    'it reaches payments through the ORDER, the only join there is',
    /items: \{ some: \{ name: params\.itemName/.test(sales) && /payments: \{/.test(sales),
  )
  check(
    'it never divides a payment across the lines of its bill',
    !/lineTotal\s*\/\s*subtotal/.test(sales) && !/apportion/i.test(sales),
    'There is no record of which part of a payment paid for which dish.',
  )
  check(
    'the screen says the amount is for the whole bill',
    page.includes('A payment settles a whole bill'),
  )
  check(
    'and shows the item’s own figure beside it',
    page.includes('This item') && page.includes('Bill total'),
  )
  check('only settled payments are counted as paid', /status === 'PAID'/.test(sales))

  /* ── 3. Against a real order ────────────────────────────────────────────── */
  console.log('\n3. Over real data')

  const restaurant = await prisma.restaurant.create({
    data: { name: `Sales ${stamp}`, slug: `sales-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Beach', code: 'BEACH' },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `cash-${stamp}@test.dev`, name: 'Nadia',
      role: 'CASHIER', passwordHash: 'x',
    },
  })

  /** One bill: two pizzas and a coke, settled half cash half card. */
  const order = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `S-${stamp}-1`,
      status: 'COMPLETED', paymentStatus: 'PAID', customerName: 'Walk-in', customerPhone: '',
      subtotal: 3_000_00, grandTotal: 3_000_00, paidTotal: 3_000_00,
      placedAt: new Date(),
      items: {
        create: [
          { name: 'Pizza', quantity: 2, unitPrice: 1_000_00, lineTotal: 2_000_00 },
          { name: 'Coke', quantity: 1, unitPrice: 1_000_00, lineTotal: 1_000_00 },
        ],
      },
      payments: {
        create: [
          { restaurantId: restaurant.id, method: 'CASH', amount: 1_500_00, status: 'PAID', paidAt: new Date(), receivedById: cashier.id },
          { restaurantId: restaurant.id, method: 'CARD', amount: 1_500_00, status: 'PAID', paidAt: new Date(), receivedById: cashier.id },
        ],
      },
    },
  })

  /** A second bill with the same dish, at a branch the viewer may not reach. */
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: other.id, orderNumber: `S-${stamp}-2`,
      status: 'COMPLETED', paymentStatus: 'PAID', customerName: '', customerPhone: '',
      subtotal: 1_000_00, grandTotal: 1_000_00, paidTotal: 1_000_00, placedAt: new Date(),
      items: { create: [{ name: 'Pizza', quantity: 1, unitPrice: 1_000_00, lineTotal: 1_000_00 }] },
      payments: { create: [{ restaurantId: restaurant.id, method: 'CASH', amount: 1_000_00, status: 'PAID', paidAt: new Date() }] },
    },
  })

  /** A cancelled bill, which is not a sale at all. */
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `S-${stamp}-3`,
      status: 'CANCELLED', paymentStatus: 'UNPAID', customerName: '', customerPhone: '',
      subtotal: 1_000_00, grandTotal: 1_000_00, placedAt: new Date(),
      items: { create: [{ name: 'Pizza', quantity: 9, unitPrice: 1_000_00, lineTotal: 9_000_00 }] },
    },
  })

  const range = resolveRange({ preset: 'LAST_7', timeZone: 'Asia/Colombo' })

  const everywhere = await getItemPaymentDetail({
    restaurantId: restaurant.id, range, branchIds: null, itemName: 'Pizza',
  })
  check('both live bills with that dish are found', everywhere.orders === 2, `${everywhere.orders}`)
  check('the cancelled one is not', !everywhere.rows.some((r) => r.orderNumber.endsWith('-3')))
  check('the quantity is the dish, not the bill', everywhere.quantity === 3, `${everywhere.quantity}`)
  check(
    'the item’s own revenue is its lines: 2000 + 1000',
    everywhere.lineRevenue === 3_000_00,
    `${everywhere.lineRevenue}`,
  )
  check(
    'and the bills those lines were on total more: 3000 + 1000',
    everywhere.billTotal === 4_000_00,
    `${everywhere.billTotal}`,
  )
  check('which is deliberately a different number', everywhere.billTotal !== everywhere.lineRevenue)

  const atMain = await getItemPaymentDetail({
    restaurantId: restaurant.id, range, branchIds: [branch.id], itemName: 'Pizza',
  })
  check('a branch-confined viewer sees only their branch’s bill', atMain.orders === 1)
  check('an empty reach sees nothing at all', (
    await getItemPaymentDetail({ restaurantId: restaurant.id, range, branchIds: [], itemName: 'Pizza' })
  ).orders === 0)

  const row = atMain.rows[0]
  check('the bill lists both its payments', row.payments.length === 2)
  check(
    'each naming its method, amount and who took it',
    row.payments.every((p) => p.methodLabel.length > 0 && p.amount === 1_500_00 && p.receivedByName === 'Nadia'),
  )
  check('the bill total is the whole bill', row.orderTotal === 3_000_00)
  check('and this item’s share of it is shown separately', row.lineTotal === 2_000_00 && row.quantity === 2)

  const coke = await getItemPaymentDetail({
    restaurantId: restaurant.id, range, branchIds: null, itemName: 'Coke',
  })
  check(
    'a different dish on the SAME bill reports the same bill and its own line',
    coke.orders === 1 && coke.rows[0]?.orderNumber === order.orderNumber && coke.rows[0]?.lineTotal === 1_000_00,
  )
  check(
    'so the two dishes’ line totals add to the bill, and neither claims all of it',
    coke.lineRevenue + 2_000_00 === 3_000_00,
  )

  check(
    'a dish nobody ordered returns an empty answer, not an error',
    (await getItemPaymentDetail({ restaurantId: restaurant.id, range, branchIds: null, itemName: `Nothing ${stamp}` })).orders === 0,
  )

  await prisma.payment.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
