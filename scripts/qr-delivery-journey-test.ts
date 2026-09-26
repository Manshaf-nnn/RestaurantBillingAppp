/**
 * A delivery guest's whole journey, over HTTP, with no tenant cookie.
 *
 * ── Why this walks past the checkout ────────────────────────────────────────
 *
 * The 404 after ordering shipped twice. Every unit test around it was green,
 * because nothing followed the guest from the checkout to the tracker: the
 * tracker lived under `/order`, whose layout resolves the restaurant from a
 * cookie the `/m/<code>` tree deliberately never sets. A page fix could not
 * help — the layout refused first. So this test does what a guest does:
 * scans, orders, and then opens the tracker and the bill, asserting on the
 * bytes that come back.
 *
 * Run: BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/qr-delivery-journey-test.ts
 */
import { placeOrder } from '../src/features/orders/service'
import { newPublicId } from '../src/features/qr/public-id'
import { saveLocation, resolveLocationForOrder } from '../src/features/qr/locations'
import { prisma } from '../src/server/db/prisma'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const GUEST_COOKIE = 'ros_gs'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    return
  }

  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Journey ${stamp}`, slug: `journey-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Campus', code: 'CMP', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Kottu', slug: `kottu-${stamp}`, price: 90_000 },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, foodId: dish.id, branchId: branch.id, isAvailable: true },
  })

  // A delivery leaflet: no table, asks where to deliver, and insists on it.
  const code = newPublicId()
  const experience = await prisma.qrExperience.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, publicId: code, name: 'Campus delivery',
      type: 'ORDERING', askTable: false, askLocation: true, requireLocation: true,
    },
  })
  const uni = await saveLocation({ restaurantId: restaurant.id, input: { name: 'University', branchId: branch.id } })
  const hostel = await saveLocation({
    restaurantId: restaurant.id, input: { name: 'Boys Hostel', parentId: uni.id, branchId: branch.id },
  })

  console.log('\n── 1. The scan lands ──')
  const landing = await fetch(`${BASE}/m/${code}`, { redirect: 'manual' })
  check('the code opens', landing.status === 200, String(landing.status))

  console.log('\n── 2. The order is placed as a delivery, to a place ──')
  const guestSession = `gs_${stamp}`
  const deliveryLocation = await resolveLocationForOrder({
    restaurantId: restaurant.id, branchId: branch.id, locationId: hostel.id,
  })
  const order = await placeOrder({
    restaurantId: restaurant.id, branchId: branch.id, tableId: null,
    type: 'DELIVERY', channel: 'QR', customerName: 'Nila', customerPhone: '0771234567',
    items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
    guestSessionId: guestSession, qrExperienceId: experience.id, deliveryLocation,
  })
  check('it is a DELIVERY, not a takeaway', order.type === 'DELIVERY', order.type)
  check('it knows where it is going', order.deliveryLocationName === 'University — Boys Hostel', String(order.deliveryLocationName))

  const cookie = `${GUEST_COOKIE}=${guestSession}`

  console.log('\n── 3. The tracker, under the code, with no tenant cookie ──')
  const track = await fetch(`${BASE}/m/${code}/track/${order.id}`, { headers: { cookie }, redirect: 'manual' })
  const trackBody = await track.text()
  check('the tracker loads', track.status === 200, String(track.status))
  check('it is this order', trackBody.includes(order.orderNumber))
  check('the last step says Delivered, not Served', trackBody.includes('Delivered') && !trackBody.includes('>Served<'))
  check('the header names the place, not a table', trackBody.includes('University — Boys Hostel'))
  check('"view bill" stays under the code', trackBody.includes(`/m/${code}/bill/${order.id}`))
  check('"add more items" stays under the code', trackBody.includes(`/m/${code}/menu?add=${order.id}`))
  check('…and nothing points back into the cookie tree', !trackBody.includes('/order/bill/') && !trackBody.includes('/order/track/'))

  console.log('\n── 4. The bill, the same way ──')
  const bill = await fetch(`${BASE}/m/${code}/bill/${order.id}`, { headers: { cookie }, redirect: 'manual' })
  const billBody = await bill.text()
  check('the bill loads', bill.status === 200, String(bill.status))
  check('it is this bill', billBody.includes(order.orderNumber))
  check('its links stay under the code', billBody.includes(`/m/${code}/track/${order.id}`) && !billBody.includes('/order/track/'))

  console.log('\n── 5. Whose order it is still matters ──')
  const stranger = await fetch(`${BASE}/m/${code}/track/${order.id}`, { redirect: 'manual' })
  const strangerBody = await stranger.text()
  check('with no guest session the order is not shown', stranger.status === 200 && !strangerBody.includes(order.orderNumber))

  /*
   * The bug this file exists for, kept as a fact: the old route, reached the
   * way a QR guest reached it — guest cookie, no tenant cookie — is a 404,
   * because its LAYOUT refuses before any page runs. That is why the QR flow
   * has a tracker of its own.
   */
  console.log('\n── 6. Why the QR tree has its own tracker ──')
  const old = await fetch(`${BASE}/order/track/${order.id}`, { headers: { cookie }, redirect: 'manual' })
  check('the /order tracker cannot serve a guest with no tenant cookie', old.status === 404, String(old.status))

  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.deliveryLocation.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.qrExperience.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
