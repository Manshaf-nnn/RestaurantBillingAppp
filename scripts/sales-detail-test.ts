/**
 * The sales screen's tiles and drill-downs.
 *
 * The thing actually worth pinning here is the discount column. A discount
 * belongs to a bill; the by-item and by-time tables show it per row; so it is
 * divided, and a division that rounds is a division that can lose money. These
 * check that it does not: every bill's shares add back to that bill's discount,
 * and each table's column adds back to the tile above it.
 */
import { prisma } from '../src/server/db/prisma'
import { getSalesReport } from '../src/features/reports/sales'
import { getSalesBreakdowns, getSalesDeltas } from '../src/features/reports/sales-detail'
import { resolveRange } from '../src/features/reports/range'

let passed = 0
let failed = 0
function check(what: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${what}`) }
  else { failed += 1; console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`) }
}

const S = Date.now().toString(36)

async function main() {
  const shop = await prisma.restaurant.create({
    data: {
      name: `SalesDetail ${S}`, slug: `salesdetail-${S}`, currency: 'LKR',
      timezone: 'Asia/Colombo', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: shop.id, name: `Mains ${S}`, slug: `mains-${S}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: shop.id, categoryId: category.id, name: `Kottu ${S}`,
      slug: `kottu-${S}`, price: 1_000_00, isAvailable: true,
      imageUrl: 'https://example.test/kottu.jpg',
    },
  })
  const drink = await prisma.food.create({
    data: {
      restaurantId: shop.id, categoryId: category.id, name: `Tea ${S}`,
      slug: `tea-${S}`, price: 300_00, isAvailable: true,
    },
  })

  /*
   * A bill whose discount does NOT divide evenly: 1,000 off a 1,300 bill across
   * a 1,000 line and a 300 line is 769.23… and 230.76…, so whatever the rounding
   * does, the two shares have to come back to exactly 1,000.
   */
  const now = new Date()
  const order = await prisma.order.create({
    data: {
      restaurantId: shop.id, branchId: branch.id, orderNumber: `SD-${S}-1`,
      type: 'DINE_IN', status: 'COMPLETED', paymentStatus: 'PAID',
      customerName: 'Guest', customerPhone: '0770000000', subtotal: 1_300_00, discountTotal: 1_000_00, manualDiscount: 1_000_00, loyaltyDiscount: 0,
      taxTotal: 0, serviceCharge: 0, grandTotal: 300_00, paidTotal: 300_00,
      placedAt: now,
      items: {
        create: [
          { foodId: dish.id, name: dish.name, unitPrice: 1_000_00, quantity: 1, lineTotal: 1_000_00 },
          { foodId: drink.id, name: drink.name, unitPrice: 300_00, quantity: 1, lineTotal: 300_00 },
        ],
      },
    },
  })
  await prisma.payment.create({
    data: {
      restaurantId: shop.id, orderId: order.id, method: 'CASH', status: 'PAID',
      amount: 300_00, destination: 'cash', paidAt: now,
    },
  })

  // A second bill with no discount at all, and two of one thing.
  const order2 = await prisma.order.create({
    data: {
      restaurantId: shop.id, branchId: branch.id, orderNumber: `SD-${S}-2`,
      type: 'DINE_IN', status: 'COMPLETED', paymentStatus: 'PAID',
      customerName: 'Guest', customerPhone: '0770000000', subtotal: 600_00, discountTotal: 0, loyaltyDiscount: 0,
      taxTotal: 0, serviceCharge: 0, grandTotal: 600_00, paidTotal: 600_00,
      placedAt: now,
      items: {
        create: [{ foodId: drink.id, name: drink.name, unitPrice: 300_00, quantity: 2, lineTotal: 600_00 }],
      },
    },
  })
  await prisma.payment.create({
    data: {
      restaurantId: shop.id, orderId: order2.id, method: 'CARD', status: 'PAID',
      amount: 600_00, destination: 'card', paidAt: now,
    },
  })

  const range = resolveRange({ preset: 'TODAY', timeZone: shop.timezone })
  const sales = await getSalesReport({ restaurantId: shop.id, range })
  const breakdowns = await getSalesBreakdowns({
    restaurantId: shop.id, range, timeZone: shop.timezone, netSales: sales.totals.netSales,
  })

  console.log('\n── Totals ───────────────────────────────────────────────')
  // One kottu and one tea on the first bill, two teas on the second.
  check('four things were sold, counting each tea', sales.totals.itemsSold === 4,
    `got ${sales.totals.itemsSold}`)
  check('gross is both bills', sales.totals.grossSales === 1_900_00, `got ${sales.totals.grossSales}`)
  check('the discount is the one bill that had one', sales.totals.discounts === 1_000_00,
    `got ${sales.totals.discounts}`)

  console.log('\n── The discount divides exactly ─────────────────────────')
  const itemDiscount = breakdowns.byItem.reduce((s, r) => s + r.discount, 0)
  check('the by-item discounts sum to the bill discount, to the cent',
    itemDiscount === 1_000_00, `got ${itemDiscount}`)
  const timeDiscount = breakdowns.byTime.reduce((s, r) => s + r.discount, 0)
  check('and so do the by-time discounts', timeDiscount === 1_000_00, `got ${timeDiscount}`)

  const kottu = breakdowns.byItem.find((r) => r.label === dish.name)
  const tea = breakdowns.byItem.find((r) => r.label === drink.name)
  check('the bigger line carries the bigger share', (kottu?.discount ?? 0) > (tea?.discount ?? 0),
    `kottu ${kottu?.discount}, tea ${tea?.discount}`)
  /*
   * 1,000 × 1,000/1,300 = 769.23 → 769.23 rounds to 76,923 minor units; the tea
   * takes the remainder. The exact split matters less than that they add up, but
   * pinning it catches a change of rule.
   */
  check('the share is proportional to what the line contributed',
    kottu?.discount === 76_923 && tea?.discount === 23_077,
    `kottu ${kottu?.discount}, tea ${tea?.discount}`)

  console.log('\n── Net is gross less the share ──────────────────────────')
  check('every row nets out', breakdowns.byItem.every((r) => r.net === r.gross - r.discount))
  const itemNet = breakdowns.byItem.reduce((s, r) => s + r.net, 0)
  check('and the column equals gross less discounts overall',
    itemNet === 1_900_00 - 1_000_00, `got ${itemNet}`)

  console.log('\n── Quantities and categories ────────────────────────────')
  check('the tea row counts all three teas across both bills', tea?.itemsSold === 3,
    `got ${tea?.itemsSold}`)
  check('the tea was bought on two bills', tea?.orders === 2, `got ${tea?.orders}`)
  check('a row carries its category', kottu?.sub === category.name, `got ${kottu?.sub}`)
  check('and the dish\'s picture, for the list that shows one',
    kottu?.imageUrl === 'https://example.test/kottu.jpg', `got ${kottu?.imageUrl}`)
  // The tea has none, and that is a dish without a picture, not an error.
  check('a dish with no picture reports none', tea?.imageUrl === null, `got ${tea?.imageUrl}`)

  console.log('\n── Payment methods ──────────────────────────────────────')
  const cash = breakdowns.byPayment.find((r) => r.key === 'CASH')
  const card = breakdowns.byPayment.find((r) => r.key === 'CARD')
  check('cash took the discounted bill', cash?.gross === 300_00, `got ${cash?.gross}`)
  check('card took the other', card?.gross === 600_00, `got ${card?.gross}`)
  check('the method reads as a word, not an enum', card?.label === 'Card', `got ${card?.label}`)

  console.log('\n── Comparing with the period before ─────────────────────')
  const deltas = await getSalesDeltas({
    restaurantId: shop.id, range,
    current: {
      grossSales: sales.totals.grossSales, orders: sales.totals.orders,
      averageOrderValue: sales.totals.averageOrderValue, itemsSold: sales.totals.itemsSold,
      discounts: sales.totals.discounts, netSales: sales.totals.netSales,
    },
  })
  check('nothing sold yesterday, so there is no trend to claim', deltas.grossSales === null,
    `got ${deltas.grossSales}`)
  check('and the screen is told what it was compared against',
    typeof deltas.previous.from === 'string' && deltas.previous.from < range.from.toISOString())

  console.log('\n── Another tenant cannot see any of it ──────────────────')
  const other = await prisma.restaurant.create({
    data: { name: `Other ${S}`, slug: `other-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  const theirs = await getSalesBreakdowns({
    restaurantId: other.id, range, timeZone: 'Asia/Colombo', netSales: 0,
  })
  check('a neighbour reads none of our items', theirs.byItem.length === 0)
  check('and none of our payments', theirs.byPayment.length === 0)

  await prisma.payment.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: shop.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.food.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.category.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.deleteMany({ where: { id: { in: [shop.id, other.id] } } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
