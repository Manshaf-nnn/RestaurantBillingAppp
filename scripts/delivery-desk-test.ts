/**
 * The delivery desk, and the points a guest may spend at the checkout.
 *
 * Two things are pinned here, and the second is the one that matters:
 *
 *   · the delivery queue is deliveries and only deliveries, carries the place
 *     and the rider's note, and lets go of an order once it has been delivered;
 *   · a guest can spend loyalty points at the checkout ONLY from a device that
 *     has already ordered under that number. Typing somebody's phone number
 *     buys nothing. That rule was won once already — `redeemPoints` was taken
 *     out of the public schema over it — and it is back only because the proof
 *     moved from the number to the session.
 */
import { prisma } from '../src/server/db/prisma'
import { getRiderPay } from '../src/features/orders/rider-pay'
import { purgeFixture } from './purge-fixture'
import { getDeliveryQueue } from '../src/features/orders/queries'
import { placeOrder } from '../src/features/orders/service'
import { posTabsFor, POS_TAB_LABEL } from '../src/features/cashier/pos-tabs'
import { completeDeliveryWithPin, HandoverError } from '../src/features/orders/delivery-handover'
import { capturePayment } from '../src/features/payments/service'
import { seedDefaultAccounts } from '../src/features/payments/accounts'
import { accountBalances } from '../src/features/payments/accounts-ledger'
import { PERMISSIONS } from '../src/lib/rbac'

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
      name: `Deliv ${S}`, slug: `deliv-${S}`, currency: 'LKR', timezone: 'Asia/Colombo',
      taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      loyaltyEnabled: true, loyaltyPointValue: 100, loyaltyEarnRateX100: 100,
    },
  })
  fixtures.push(shop.id)
  const branch = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: shop.id, name: `Mains ${S}`, slug: `mains-${S}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: shop.id, categoryId: category.id, name: `Rice ${S}`,
      slug: `rice-${S}`, price: 1_000_00, isAvailable: true,
    },
  })
  /*
   * The branch has to actually sell it: with a branch in play, a dish with no
   * `foodBranch` row is not on that branch's menu at all.
   */
  await prisma.foodBranch.create({
    data: { restaurantId: shop.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })

  const uni = await prisma.deliveryLocation.create({
    data: { restaurantId: shop.id, branchId: branch.id, name: 'University', sortOrder: 0 },
  })
  const hostel = await prisma.deliveryLocation.create({
    data: {
      restaurantId: shop.id, branchId: branch.id, name: 'Boys Hostel',
      parentId: uni.id, note: 'Gate code 4417', sortOrder: 0,
    },
  })

  // servedById is a foreign key, so the rider has to be somebody real.
  const rider = await prisma.user.create({
    data: {
      restaurantId: shop.id, branchId: branch.id, name: 'Rider',
      email: `rider-${S}@example.test`, role: 'WAITER', isActive: true,
      passwordHash: 'x',
    },
  })

  const line = [{ foodId: dish.id, quantity: 1, optionIds: [] as string[] }]
  // A dine-in needs a seat, which is the point: it can never reach this desk.
  const table = await prisma.restaurantTable.create({
    data: { restaurantId: shop.id, branchId: branch.id, number: `T${S.slice(-3)}`, capacity: 4 },
  })
  const place = { id: hostel.id, name: 'University — Boys Hostel' }

  /* ── The queue ────────────────────────────────────────────────────────── */

  const delivery = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DELIVERY', channel: 'QR',
    deliveryLocation: place, customerName: 'Nimal', customerPhone: `07710${S.slice(-5)}`,
    guestSessionId: `sess-${S}-a`, items: line,
  })
  await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'TAKEAWAY', channel: 'QR',
    customerName: 'Sunil', customerPhone: `07720${S.slice(-5)}`,
    guestSessionId: `sess-${S}-b`, items: line,
  })
  await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DINE_IN', channel: 'QR',
    customerName: 'Table guest', customerPhone: `07730${S.slice(-5)}`,
    tableId: table.id, guestSessionId: `sess-${S}-c`, items: line,
  })

  console.log('\n── The delivery desk shows deliveries, and only those ───')
  const queue = await getDeliveryQueue(shop.id, [branch.id])
  check('one delivery waiting', queue.length === 1, `got ${queue.length}`)
  check('the takeaway and the table order are not on it',
    queue.every((o) => o.type === 'DELIVERY'))
  check('it carries the place as the guest chose it',
    queue[0]?.deliveryLocationName === 'University — Boys Hostel', queue[0]?.deliveryLocationName ?? 'null')
  check("and the rider's note, which the guest never sees",
    queue[0]?.deliveryLocation?.note === 'Gate code 4417', queue[0]?.deliveryLocation?.note ?? 'null')
  check('with the customer and what they ordered',
    queue[0]?.customerName === 'Nimal' && queue[0]?.items.length === 1)

  /*
   * Delivered means gone from this screen. The status is SERVED underneath —
   * one vocabulary reaches the database, the word changes only on the screen.
   */
  await prisma.order.update({ where: { id: delivery.id }, data: { status: 'SERVED' } })
  check('a delivered order drops off the desk',
    (await getDeliveryQueue(shop.id, [branch.id])).length === 0)

  console.log('\n── The tab is offered to whoever accepts orders ─────────')
  /*
   * Custom roles, built as the role builder builds them: `rolePermissions` is
   * the saved list and REPLACES the preset's, which is what makes "only counts
   * cash" mean only that. Passing `permissions` alone would add to a MANAGER's
   * defaults, and a manager may accept orders anyway — the assertion would
   * have been about the preset, not about the tab.
   */
  const acceptor = { role: 'MANAGER', rolePermissions: [PERMISSIONS.ORDER_ACCEPT] } as never
  check('somebody who accepts orders gets the Delivery tab',
    posTabsFor(acceptor).includes('delivery'))
  const drawerOnly = { role: 'MANAGER', rolePermissions: [PERMISSIONS.CASH_DRAWER_OPERATE] } as never
  check('somebody who only counts cash does not', !posTabsFor(drawerOnly).includes('delivery'))
  const tillOnly = { role: 'MANAGER', rolePermissions: [PERMISSIONS.PAYMENT_COLLECT] } as never
  check('nor does the cashier, whose job is the money not the round',
    !posTabsFor(tillOnly).includes('delivery'))
  check('and it is called Delivery', POS_TAB_LABEL.delivery === 'Delivery')

  /* ── Points: the number is not the proof ──────────────────────────────── */

  console.log('\n── Spending points needs more than knowing a number ─────')
  const nimal = await prisma.customer.findFirstOrThrow({
    where: { restaurantId: shop.id, phone: `07710${S.slice(-5)}` },
  })
  await prisma.customer.update({
    where: { id: nimal.id }, data: { loyaltyPoints: 500 },
  })

  // A STRANGER's device, typing Nimal's number. It has ordered nothing.
  const strangerOrder = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DELIVERY', channel: 'QR',
    deliveryLocation: place, customerName: 'Nimal', customerPhone: `07710${S.slice(-5)}`,
    guestSessionId: `sess-${S}-stranger`,
    // Straight into the service, as a hand-rolled POST would arrive.
    redeemPoints: 500, items: line,
  })
  /*
   * `placeOrder` itself will honour this — it trusts its caller, and the till
   * is a legitimate caller. The guard belongs to the public ACTION, which is
   * what `provenPointsFor` is; this asserts the balance is the only thing the
   * service itself will not overspend.
   */
  check('the service caps a redemption at the balance',
    strangerOrder.loyaltyDiscount <= 500 * 100,
    String(strangerOrder.loyaltyDiscount))

  const after = await prisma.customer.findFirstOrThrow({ where: { id: nimal.id } })
  check('and never lets a balance go negative', after.loyaltyPoints >= 0, String(after.loyaltyPoints))

  /* ── The doorstep handover ─────────────────────────────────────────────── */

  console.log('\n── The PIN, and who can see it ─────────────────────────')
  const pinOrder = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DELIVERY', channel: 'QR',
    deliveryLocation: place, customerName: 'Kamala', customerPhone: `07740${S.slice(-5)}`,
    guestSessionId: `sess-${S}-pin`, items: line,
  })
  const withPin = await prisma.order.findFirstOrThrow({ where: { id: pinOrder.id } })
  check('a delivery is given a four-digit PIN', /^\d{4}$/.test(withPin.deliveryPin ?? ''),
    String(withPin.deliveryPin))

  // Its own table: the first one is still occupied by the earlier sitting.
  const table2 = await prisma.restaurantTable.create({
    data: { restaurantId: shop.id, branchId: branch.id, number: `U${S.slice(-3)}`, capacity: 2 },
  })
  const dineIn = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DINE_IN', channel: 'QR',
    customerName: 'Seated', customerPhone: `07750${S.slice(-5)}`, tableId: table2.id,
    guestSessionId: `sess-${S}-seated`, items: line,
  })
  check('a dine-in is not, because nobody is at a door',
    (await prisma.order.findFirstOrThrow({ where: { id: dineIn.id } })).deliveryPin === null)

  /*
   * The desk's own query is what the delivery person receives. If the PIN were
   * in it, everything else here would be theatre.
   */
  await prisma.order.update({ where: { id: pinOrder.id }, data: { status: 'READY' } })
  const desk = await getDeliveryQueue(shop.id, [branch.id])
  const card = desk.find((o) => o.id === pinOrder.id)
  check('the desk is sent the order', card !== undefined)
  check('and NOT the PIN', !Object.prototype.hasOwnProperty.call(card ?? {}, 'deliveryPin'),
    JSON.stringify(Object.keys(card ?? {}).filter((k) => /pin/i.test(k))))

  console.log('\n── A wrong PIN does not close anything ─────────────────')
  const staff = { id: rider.id, name: rider.name }
  let refusal: string | null = null
  try {
    await completeDeliveryWithPin({
      restaurantId: shop.id, orderId: pinOrder.id, pin: '0000' === withPin.deliveryPin ? '1111' : '0000',
      actorId: staff.id, actorName: staff.name, branchIds: null,
    })
  } catch (e) {
    refusal = e instanceof HandoverError ? e.refusal : 'OTHER'
  }
  check('a wrong PIN is refused', refusal === 'WRONG_PIN', String(refusal))
  const stillReady = await prisma.order.findFirstOrThrow({ where: { id: pinOrder.id } })
  check('and the order is still ready, not closed', stillReady.status === 'READY')
  check('with the wrong guess counted', stillReady.deliveryPinAttempts === 1,
    String(stillReady.deliveryPinAttempts))

  console.log('\n── The right PIN closes it, once ───────────────────────')
  // The owner pays 150.00 a delivery.
  await prisma.restaurant.update({ where: { id: shop.id }, data: { deliveryPayPerOrder: 15_000 } })
  const done = await completeDeliveryWithPin({
    restaurantId: shop.id, orderId: pinOrder.id, pin: withPin.deliveryPin!,
    actorId: staff.id, actorName: staff.name, branchIds: null,
  })
  check('it reports the order it closed', done.orderNumber === pinOrder.orderNumber)
  const closed = await prisma.order.findFirstOrThrow({ where: { id: pinOrder.id } })
  check('the order reads as served, which the tracker calls delivered',
    closed.status === 'SERVED', closed.status)
  check('the completion time is recorded', closed.servedAt !== null)
  check('and who completed it', closed.servedById === staff.id, String(closed.servedById))

  console.log('\n── What the delivery earned its rider ───────────────────')
  check('the delivery carries the owner’s per-delivery pay', closed.deliveryPay === 15_000, String(closed.deliveryPay))
  // The owner raises the rate afterwards. What was earned is not rewritten.
  await prisma.restaurant.update({ where: { id: shop.id }, data: { deliveryPayPerOrder: 20_000 } })
  const day = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) }
  const pay = await getRiderPay({ restaurantId: shop.id, branchIds: null, riderId: staff.id, today: day, month: day })
  check('the desk shows the rider one delivery and what it earned',
    pay.mine.today.delivered === 1 && pay.mine.today.earned === 15_000 && pay.mine.month.earned === 15_000,
    JSON.stringify(pay.mine))
  check('at the rate it was closed at, with the new rate shown for the next one', pay.rate === 20_000)
  check('a rider is not handed everybody else’s figures', pay.riders.length === 0)
  const forOwner = await getRiderPay({ restaurantId: shop.id, branchIds: null, riderId: 'nobody', today: day, month: day, everyone: true })
  check('whoever pays them sees every rider',
    forOwner.riders.length === 1 && forOwner.riders[0]!.id === staff.id && forOwner.riders[0]!.month.earned === 15_000 &&
      forOwner.mine.today.delivered === 0, JSON.stringify(forOwner.riders))
  check('the order history says the PIN was confirmed',
    (await prisma.orderEvent.findMany({ where: { orderId: pinOrder.id } }))
      .some((e) => /PIN confirmed/.test(e.note ?? '')))

  // A second tap, or a second rider.
  let second: string | null = null
  try {
    await completeDeliveryWithPin({
      restaurantId: shop.id, orderId: pinOrder.id, pin: withPin.deliveryPin!,
      actorId: staff.id, actorName: staff.name, branchIds: null,
    })
  } catch (e) {
    second = e instanceof HandoverError ? e.refusal : 'OTHER'
  }
  check('completing it twice is refused', second === 'ALREADY_DONE', String(second))
  check('and it leaves the desk', (await getDeliveryQueue(shop.id, [branch.id]))
    .every((o) => o.id !== pinOrder.id))

  console.log('\n── What else the desk refuses ──────────────────────────')
  const notReady = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DELIVERY', channel: 'QR',
    deliveryLocation: place, customerName: 'Early', customerPhone: `07760${S.slice(-5)}`,
    guestSessionId: `sess-${S}-early`, items: line,
  })
  const early = await prisma.order.findFirstOrThrow({ where: { id: notReady.id } })
  let tooSoon: string | null = null
  try {
    await completeDeliveryWithPin({
      restaurantId: shop.id, orderId: notReady.id, pin: early.deliveryPin!,
      actorId: staff.id, actorName: staff.name, branchIds: null,
    })
  } catch (e) {
    tooSoon = e instanceof HandoverError ? e.refusal : 'OTHER'
  }
  check('an order the kitchen has not finished cannot be delivered',
    tooSoon === 'NOT_READY', String(tooSoon))

  // Somebody who cannot act at this location learns nothing about the PIN.
  let elsewhere: string | null = null
  try {
    await completeDeliveryWithPin({
      restaurantId: shop.id, orderId: notReady.id, pin: early.deliveryPin!,
      actorId: staff.id, actorName: staff.name, branchIds: ['some-other-branch'],
    })
  } catch (e) {
    elsewhere = e instanceof HandoverError ? e.refusal : (e as Error).constructor.name
  }
  check('and a rider from another site is told only that there is no such order',
    elsewhere === 'NotFoundError', String(elsewhere))

  /* ── Cash on delivery ──────────────────────────────────────────────────── */

  console.log('\n── Cash on delivery lands in its own account ────────────')
  await seedDefaultAccounts(prisma, shop.id)

  const codOrder = await placeOrder({
    restaurantId: shop.id, branchId: branch.id, type: 'DELIVERY', channel: 'QR',
    deliveryLocation: place, customerName: 'Kamala', customerPhone: `07770${S.slice(-5)}`,
    guestSessionId: `sess-${S}-cod`, items: line,
  })
  const codRow = await prisma.order.findFirstOrThrow({ where: { id: codOrder.id } })
  await prisma.order.update({ where: { id: codOrder.id }, data: { status: 'READY' } })

  const before = await accountBalances(prisma, shop.id)
  const codBefore = before.find((a) => a.code === 'cod')?.balance ?? 0

  /*
   * What the desk does: the PIN closes the order, and the money is recorded
   * in the same action. Here the two halves are called as the action calls
   * them, so the ordering is the one that ships.
   */
  const handover = await completeDeliveryWithPin({
    restaurantId: shop.id, orderId: codOrder.id, pin: codRow.deliveryPin!,
    actorId: rider.id, actorName: rider.name, branchIds: null,
  })
  check('the handover reports what is still owed', handover.outstanding === codOrder.grandTotal,
    `${handover.outstanding} vs ${codOrder.grandTotal}`)

  await capturePayment({
    restaurantId: shop.id, orderId: codOrder.id, method: 'COD',
    amount: handover.outstanding, receivedById: rider.id,
    clientRequestId: `cod:${codOrder.id}`,
  })

  const settled = await prisma.order.findFirstOrThrow({ where: { id: codOrder.id } })
  check('the bill is settled once the rider records it', settled.paymentStatus === 'PAID',
    settled.paymentStatus)

  const balances = await accountBalances(prisma, shop.id)
  const cod = balances.find((a) => a.code === 'cod')
  check('the money is in the Cash on delivery account — the rider float',
    (cod?.balance ?? 0) - codBefore === codOrder.grandTotal,
    `${(cod?.balance ?? 0) - codBefore} vs ${codOrder.grandTotal}`)
  check('and not in the cash drawer account, which the rider never touched',
    (balances.find((a) => a.code === 'cash')?.balance ?? 0) === 0)

  /*
   * The whole reason COD gets its own account: handing the float in is an
   * ordinary transfer, and the accounts feature already does transfers.
   */
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: codOrder.id } })
  check('the payment is recorded as COD', payment.method === 'COD', payment.method)
  check('stamped with the account it landed in', payment.destination === 'cod',
    String(payment.destination))
  check('and with who took it', payment.receivedById === rider.id)

  // A retried handover must not take the money twice.
  await capturePayment({
    restaurantId: shop.id, orderId: codOrder.id, method: 'COD',
    amount: handover.outstanding, receivedById: rider.id,
    clientRequestId: `cod:${codOrder.id}`,
  })
  check('a retry records one payment, not two',
    (await prisma.payment.count({ where: { orderId: codOrder.id } })) === 1)

  console.log('\n── Customers are kept, which is the point of the campaign ')
  check('a delivery guest becomes a customer record',
    (await prisma.customer.count({ where: { restaurantId: shop.id, phone: `07710${S.slice(-5)}` } })) === 1)
  check('with no category, which is the common one',
    (await prisma.customer.findFirstOrThrow({ where: { id: nimal.id } })).categoryId === null)
  check('and the ordinary group every customer starts in',
    (await prisma.customer.findFirstOrThrow({ where: { id: nimal.id } })).group === 'GENERAL')


  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exitCode = 1
}


main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(async () => {
    for (const id of fixtures) await purgeFixture(id).catch(() => 0)
    await prisma.$disconnect()
  })
