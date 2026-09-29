/**
 * The Delivery report adds up.
 *
 * Pinned: delivered = SERVED or COMPLETED delivery orders placed in the
 * period; sales come from delivered orders only (a cancelled delivery was
 * never money); cash at the door is the PAID COD payments; the order-to-door
 * and ready-to-door averages come from the order's own stamps and skip a
 * missing stamp rather than count it as zero; places and handover staff
 * are grouped; the trend sums to the total; dine-in never counts; the branch
 * narrows; another restaurant never shows.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/delivery-report-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { getDeliveryReport } from '../src/features/orders/delivery-report'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const stamp = Date.now().toString(36)
const restaurantIds: string[] = []

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `Deliv ${stamp}`, slug: `deliv-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantIds.push(restaurant.id)
  const other = await prisma.restaurant.create({
    data: { name: `ODeliv ${stamp}`, slug: `odeliv-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantIds.push(other.id)
  const main = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true } })
  const kandy = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' } })
  const otherBranch = await prisma.branch.create({ data: { restaurantId: other.id, name: 'Else', code: 'ELS', isDefault: true } })
  const rider = await prisma.user.create({ data: { restaurantId: restaurant.id, email: `rider-${stamp}@test.local`, name: 'Sunil', passwordHash: 'x', role: 'WAITER' } })

  const now = new Date()
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
  let n = 0
  const order = async (data: {
    restaurantId?: string; branchId?: string; type?: 'DELIVERY' | 'DINE_IN'; status: 'SERVED' | 'COMPLETED' | 'CANCELLED' | 'READY'
    total: number; place?: string | null; placedMin: number; readyMin?: number | null; servedMin?: number | null; cod?: number; card?: number; byRider?: boolean
  }) => {
    n += 1
    const created = await prisma.order.create({
      data: {
        restaurantId: data.restaurantId ?? restaurant.id,
        branchId: data.branchId ?? main.id,
        orderNumber: `T${stamp}-${n}`,
        type: data.type ?? 'DELIVERY',
        status: data.status,
        customerName: `Guest ${n}`,
        customerPhone: '0771234567',
        subtotal: data.total,
        grandTotal: data.total,
        deliveryLocationName: data.place === undefined ? 'Campus — Hostel' : data.place,
        placedAt: ago(data.placedMin),
        readyAt: data.readyMin === undefined || data.readyMin === null ? null : ago(data.readyMin),
        servedAt: data.servedMin === undefined || data.servedMin === null ? null : ago(data.servedMin),
        servedById: data.byRider ? rider.id : null,
      },
    })
    for (const [method, amount] of [['COD', data.cod], ['CARD', data.card]] as const) {
      if (amount) {
        await prisma.payment.create({
          data: { restaurantId: created.restaurantId, orderId: created.id, method, status: 'PAID', amount, paidAt: now },
        })
      }
    }
    return created
  }

  // Delivered: 40 min door-to-door (ride 10), COD 1,000.
  await order({ status: 'COMPLETED', total: 1_000, placedMin: 100, readyMin: 70, servedMin: 60, cod: 1_000, byRider: true })
  // Delivered: 20 min (ride 5), prepaid by card, other place.
  await order({ status: 'SERVED', total: 2_000, place: 'Town — Office', placedMin: 50, readyMin: 35, servedMin: 30, card: 2_000, byRider: true })
  // Delivered with no ready stamp: counts for sales, skipped in the ride average.
  await order({ status: 'SERVED', total: 3_000, placedMin: 80, readyMin: null, servedMin: 20, byRider: false })
  // Cancelled: never money.
  await order({ status: 'CANCELLED', total: 9_999, placedMin: 30 })
  // Out now.
  await order({ status: 'READY', total: 500, placedMin: 15, readyMin: 5 })
  // Kandy delivery.
  await order({ branchId: kandy.id, status: 'COMPLETED', total: 4_000, place: 'Kandy — Lake', placedMin: 90, readyMin: 70, servedMin: 60, cod: 4_000 })
  // Not a delivery, and another restaurant: never counted.
  await order({ type: 'DINE_IN', status: 'COMPLETED', total: 7_777, placedMin: 40, servedMin: 30, place: null })
  await order({ restaurantId: other.id, branchId: otherBranch.id, status: 'COMPLETED', total: 5_555, placedMin: 40, servedMin: 30 })

  const window = { from: ago(24 * 60), to: new Date(now.getTime() + 60_000), previous: { from: ago(48 * 60), to: ago(24 * 60 + 1) }, timeZone: 'Asia/Colombo' }
  const r = await getDeliveryReport({ restaurantId: restaurant.id, branchIds: null, ...window })

  console.log('\n── 1. What counts ──')
  check('four delivered (served or completed, both branches)', r.delivered === 4, String(r.delivered))
  check('sales are delivered orders only — no cancelled, no dine-in, no other restaurant', r.sales === 1_000 + 2_000 + 3_000 + 4_000, String(r.sales))
  check('average order', r.averageOrder === 2_500, String(r.averageOrder))
  check('one cancelled', r.cancelled === 1)
  check('one out for delivery now', r.outNow === 1)

  console.log('\n── 2. Cash at the door ──')
  check('cash is the COD payments only, not the card', r.cashCollected === 5_000, String(r.cashCollected))
  check('two deliveries paid at the door', r.cashCount === 2, String(r.cashCount))

  console.log('\n── 3. Times ──')
  // Order to door: 40, 20, 60, 30 → mean 37.5 → 38.
  check('order-to-door averages the four', r.averageMinutes === 38, String(r.averageMinutes))
  // Ready to door: 10, 5, (skip), 10 → mean 8.33 → 8.
  check('ready-to-door skips the order with no ready stamp', r.averageRideMinutes === 8, String(r.averageRideMinutes))

  console.log('\n── 4. Groupings ──')
  check('places grouped, busiest first', r.byPlace[0]?.place === 'Campus — Hostel' && r.byPlace[0].delivered === 2, JSON.stringify(r.byPlace[0]))
  check('place shares sum to one', Math.abs(r.byPlace.reduce((s, p) => s + p.share, 0) - 1) < 1e-9)
  const sunil = r.byRider.find((x) => x.name === 'Sunil')
  check('handover staff grouped with their cash', sunil?.delivered === 2 && sunil.cash === 1_000, JSON.stringify(sunil))
  check('a delivery with no recorded staff is named as such', r.byRider.some((x) => x.name === 'Not recorded'))
  check('the trend sums to the total', r.trend.reduce((s, d) => s + d.delivered, 0) === r.delivered)
  check('recent deliveries listed with how they were paid', r.recent.length === 4 && r.recent.some((x) => x.paidBy === 'Cash at the door'))

  console.log('\n── 5. Branch ──')
  const k = await getDeliveryReport({ restaurantId: restaurant.id, branchIds: [kandy.id], ...window })
  check('Kandy sees only its own delivery', k.delivered === 1 && k.sales === 4_000 && k.outNow === 0, `${k.delivered} ${k.sales}`)
}

main()
  .catch((error) => { console.error(error); failed += 1 })
  .finally(async () => {
    for (const id of restaurantIds) {
      await prisma.payment.deleteMany({ where: { restaurantId: id } }).catch(() => null)
      await prisma.order.deleteMany({ where: { restaurantId: id } }).catch(() => null)
      await prisma.restaurant.delete({ where: { id } }).catch((error) => console.error('cleanup', error.message))
    }
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
