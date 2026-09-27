/**
 * An offer aimed at a customer category reaches that customer, everywhere.
 *
 * The bug this pins: an owner picked "Campus student" in the Customers tab,
 * gave the category an offer, and it never applied on the delivery QR menu.
 * The targeting was fine — `segment.categoryId` matched perfectly — but
 * nothing ever APPLIED it, because every discount in the system waited for
 * somebody to type a code, and a guest ordering from a leaflet has no code to
 * type and no reason to think there is one.
 *
 * So these check the two halves: an aimed offer applies on its own, and an
 * unaimed one still does not.
 */
import { prisma } from '../src/server/db/prisma'
import { purgeFixture } from './purge-fixture'
import { placeOrder } from '../src/features/orders/service'
import { getCashierQueue } from '../src/features/orders/queries'

let passed = 0
let failed = 0
function check(what: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${what}`) }
  else { failed += 1; console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`) }
}

const S = Date.now().toString(36)
/**
 * Every tenant this suite makes, so the teardown cannot miss one.
 *
 * Filled as they are created and purged in a `finally`, because the cleanup
 * that only runs when every assertion passes is the cleanup that leaves
 * abandoned tenants behind exactly when something has already gone wrong.
 * Nine of mine ended up in the database that way and broke another suite,
 * which looks a customer up by phone without scoping it to a restaurant.
 */
const fixtures: string[] = []


async function main() {
  const shop = await prisma.restaurant.create({
    data: {
      name: `Offer ${S}`, slug: `offer-${S}`, currency: 'LKR', timezone: 'Asia/Colombo',
      taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  fixtures.push(shop.id)
  const branch = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const menuCat = await prisma.category.create({
    data: { restaurantId: shop.id, name: `Mains ${S}`, slug: `mains-${S}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: shop.id, categoryId: menuCat.id, name: `Rice ${S}`,
      slug: `rice-${S}`, price: 1_000_00, isAvailable: true,
    },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: shop.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })
  const place = await prisma.deliveryLocation.create({
    data: { restaurantId: shop.id, branchId: branch.id, name: 'Hostel', sortOrder: 0 },
  })

  // The owner's category, and somebody in it.
  const campus = await prisma.customerCategory.create({
    data: { restaurantId: shop.id, name: `Campus student ${S}` },
  })
  const student = await prisma.customer.create({
    data: {
      restaurantId: shop.id, name: 'Nimal', phone: `07791${S.slice(-5)}`,
      categoryId: campus.id,
    },
  })
  const stranger = await prisma.customer.create({
    data: { restaurantId: shop.id, name: 'Passer by', phone: `07792${S.slice(-5)}` },
  })

  // 20% for that category, and no code anybody would think to type.
  await prisma.coupon.create({
    data: {
      restaurantId: shop.id, code: `CAMPUS${S.slice(-4)}`.toUpperCase(),
      // Basis points, not percent: 2000 bps = 20%.
      description: 'Campus students', type: 'PERCENT', value: 2_000,
      isActive: true, segment: { categoryId: campus.id },
    },
  })

  const line = [{ foodId: dish.id, quantity: 1, optionIds: [] as string[] }]
  const delivery = (phone: string, session: string) =>
    placeOrder({
      restaurantId: shop.id, branchId: branch.id, type: 'DELIVERY', channel: 'QR',
      deliveryLocation: { id: place.id, name: 'Hostel' },
      customerName: 'Guest', customerPhone: phone, guestSessionId: session, items: line,
    })

  console.log('\n── The aimed offer applies with nothing typed ───────────')
  const theirs = await delivery(student.phone!, `sess-${S}-a`)
  check('the campus student gets 20% off a 1,000 order on the delivery QR',
    theirs.couponDiscount === 200_00, String(theirs.couponDiscount))
  check('and the bill says which offer it was', theirs.couponId !== null)

  const others = await delivery(stranger.phone!, `sess-${S}-b`)
  check('somebody outside the category gets nothing',
    others.couponDiscount === 0, String(others.couponDiscount))

  /*
   * The same offer, the same customer, a different door. "Everywhere selected
   * people come to order" is the requirement, so a till order has to behave
   * the same as the leaflet.
   */
  const atTheTill = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'TAKEAWAY', channel: 'STAFF',
    customerName: 'Nimal', customerPhone: student.phone!, items: line,
  })
  check('and it reaches them at the counter too', atTheTill.couponDiscount === 200_00,
    String(atTheTill.couponDiscount))

  console.log('\n── An unaimed code is still a code ──────────────────────')
  await prisma.coupon.create({
    data: {
      restaurantId: shop.id, code: `PUBLIC${S.slice(-4)}`.toUpperCase(),
      type: 'PERCENT', value: 5_000, isActive: true,
    },
  })
  const noCode = await delivery(stranger.phone!, `sess-${S}-c`)
  check('a public 50% coupon does not fire on its own', noCode.couponDiscount === 0,
    String(noCode.couponDiscount))

  console.log('\n── A typed code is not second-guessed ───────────────────')
  const typed = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DELIVERY', channel: 'QR',
    deliveryLocation: { id: place.id, name: 'Hostel' },
    customerName: 'Nimal', customerPhone: student.phone!,
    couponCode: `PUBLIC${S.slice(-4)}`.toUpperCase(),
    guestSessionId: `sess-${S}-d`, items: line,
  })
  check('the student who types the public code gets that one, not the better aimed one',
    typed.couponDiscount === 500_00, String(typed.couponDiscount))

  console.log('\n── Deliveries are the desk’s, not the till’s ──────────')
  const queue = await getCashierQueue(shop.id, [branch.id])
  check('no delivery sits in the cashier queue', queue.every((o) => o.type !== 'DELIVERY'),
    queue.filter((o) => o.type === 'DELIVERY').length + ' found')
  check('but the takeaway still does', queue.some((o) => o.id === atTheTill.id))


  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exitCode = 1
}


main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(async () => {
    for (const id of fixtures) await purgeFixture(id).catch(() => 0)
    await prisma.$disconnect()
  })
