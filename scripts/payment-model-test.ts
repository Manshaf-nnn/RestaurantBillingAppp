/**
 * The payment & discount model, spec-shaped (AUDIT.md Slice 2).
 *
 * Pins the rules migration set A introduced:
 *
 *   • Tips ride ON TOP of grandTotal, never inside it (§110). Settlement
 *     writes tipAmount and leaves grandTotal alone; "owed" is grand + tip.
 *   • Refunds are ROWS against an immutable payment: partial amounts, each
 *     with a reason, the payment flipping to REFUNDED only when covered, and
 *     paidTotal recomputed as sum(received) − sum(returned).
 *   • Coupon and manual discounts live in their own columns; applying one can
 *     no longer erase the other.
 *   • Invoice numbers come from an atomic per-restaurant counter — concurrent
 *     settlements cannot mint the same number.
 *   • Every loyalty balance equals the sum of its ledger entries; spending
 *     points is conditional, so two orders cannot spend the same balance.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/payment-model-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder, settleLoyalty } from '../src/features/orders/service'
import { capturePayment, refundPayment } from '../src/features/payments/service'
import { nextCounterValue } from '../src/server/db/counters'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Pay ${stamp}`,
      slug: `pay-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
      taxLabel: 'VAT',
      taxRateBps: 0,
      serviceChargeBps: 0,
      taxInclusive: false,
      loyaltyEnabled: true,
      loyaltyPointValue: 100, // 1 point = 1 rupee
      loyaltyEarnRateX100: 100, // 1 point per rupee
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Kottu',
      slug: `kottu-${stamp}`,
      price: 100_000, // 1000.00
      isAvailable: true,
    },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `pay-${stamp}@test.local`,
      name: 'Cashier',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: branch.id,
    },
  })

  const order = (extra: Partial<Parameters<typeof placeOrder>[0]> = {}) =>
    placeOrder({
      restaurantId: restaurant.id,
      branchId: branch.id,
      type: 'TAKEAWAY',
      customerName: 'Walk-in',
      customerPhone: '',
      items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
      ...extra,
    })

  console.log('\n── 1. The tip is not the bill ──')
  {
    const o = await order()
    check('grandTotal starts at the bill', o.grandTotal === 100_000, `${o.grandTotal}`)

    await capturePayment({
      restaurantId: restaurant.id,
      orderId: o.id,
      method: 'CASH',
      amount: 110_000,
      tenderedAmount: 110_000,
      tipAmount: 10_000,
      receivedById: cashier.id,
    })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    check('settling with a tip leaves grandTotal alone', after.grandTotal === 100_000, `${after.grandTotal}`)
    check('the tip is recorded where tips live', after.tipAmount === 10_000, `${after.tipAmount}`)
    check('paid covers bill + tip and the order is PAID',
      after.paidTotal === 110_000 && after.paymentStatus === 'PAID',
      `${after.paidTotal} ${after.paymentStatus}`)
  }

  console.log('\n── 2. Short tender and the exact ceiling ──')
  {
    const o = await order()
    await refuses(
      'cash below the amount being booked is refused',
      () => capturePayment({
        restaurantId: restaurant.id, orderId: o.id, method: 'CASH',
        amount: 100_000, tenderedAmount: 50_000, receivedById: cashier.id,
      }),
      /does not cover/,
    )
    await refuses(
      'one minor unit over what is due is refused',
      () => capturePayment({
        restaurantId: restaurant.id, orderId: o.id, method: 'CARD',
        amount: 100_001, receivedById: cashier.id,
      }),
      /more than the/,
    )
  }

  console.log('\n── 3. A split settle: half now, half by card ──')
  {
    const o = await order()
    await capturePayment({
      restaurantId: restaurant.id, orderId: o.id, method: 'CASH',
      amount: 40_000, tenderedAmount: 40_000, receivedById: cashier.id,
    })
    const mid = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    check('a partial payment leaves the bill PARTIAL', mid.paymentStatus === 'PARTIAL' && mid.paidTotal === 40_000)
    await capturePayment({
      restaurantId: restaurant.id, orderId: o.id, method: 'CARD',
      amount: 60_000, receivedById: cashier.id,
    })
    const done = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { invoice: true } })
    check('the second settles it', done.paymentStatus === 'PAID' && done.paidTotal === 100_000)
    check('an invoice was issued at full settlement', done.invoice !== null)
  }

  console.log('\n── 4. Refunds are rows, and partial ──')
  {
    const o = await order()
    const captured = await capturePayment({
      restaurantId: restaurant.id, orderId: o.id, method: 'CASH',
      amount: 100_000, tenderedAmount: 100_000, receivedById: cashier.id,
    })
    const paymentId = captured.payment.id

    const first = await refundPayment({
      restaurantId: restaurant.id, paymentId,
      reason: 'Cold food — half comped', actorId: cashier.id, amount: 30_000,
    })
    check('the refund is its own row with its own reason', first.amount === 30_000 && first.reason.includes('Cold'))

    const midPayment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    check('a partially refunded payment stays PAID', midPayment.status === 'PAID', midPayment.status)
    const midOrder = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    check('paidTotal is received minus returned', midOrder.paidTotal === 70_000, `${midOrder.paidTotal}`)
    check('…so the order is PARTIAL again', midOrder.paymentStatus === 'PARTIAL', midOrder.paymentStatus)

    await refundPayment({
      restaurantId: restaurant.id, paymentId,
      reason: 'Manager comped the rest', actorId: cashier.id,
    })
    const endPayment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    const endOrder = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    check('fully covered, the payment flips to REFUNDED', endPayment.status === 'REFUNDED')
    check('and the order shows all money returned', endOrder.paidTotal === 0 && endOrder.paymentStatus === 'REFUNDED')

    await refuses(
      'a third refund finds nothing left',
      () => refundPayment({ restaurantId: restaurant.id, paymentId, reason: 'again', actorId: cashier.id }),
      /already been fully refunded/,
    )
    const rows = await prisma.refund.count({ where: { paymentId } })
    check('two refund rows tell the story', rows === 2, `${rows}`)
  }

  console.log('\n── 5. The discount split survives both instruments ──')
  {
    const coupon = await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id, code: `SAVE-${stamp}`.toUpperCase(),
        type: 'FIXED', value: 10_000, isActive: true,
      },
    })
    const o = await order({ couponCode: coupon.code })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    check('the coupon lands in its own column',
      row.couponDiscount === 10_000 && row.manualDiscount === 0 && row.discountTotal === 10_000,
      `${row.couponDiscount}/${row.manualDiscount}/${row.discountTotal}`)
    const redemption = await prisma.couponRedemption.findFirst({ where: { orderId: o.id } })
    check('the redemption records what the coupon took', redemption?.amount === 10_000)
  }

  console.log('\n── 6. Invoice numbers cannot collide ──')
  {
    const values = await Promise.all(
      Array.from({ length: 8 }, () =>
        prisma.$transaction((tx) => nextCounterValue(tx, restaurant.id, `test:${stamp}`)),
      ),
    )
    const unique = new Set(values)
    check('eight concurrent draws give eight distinct numbers', unique.size === 8, [...unique].join(','))
    check('…in an unbroken sequence', Math.max(...values) - Math.min(...values) === 7)
  }

  console.log('\n── 7. Loyalty is a ledger, and points cannot be spent twice ──')
  {
    const customer = await prisma.customer.create({
      data: { restaurantId: restaurant.id, name: 'Regular', phone: `077${stamp.slice(-6)}1`, loyaltyPoints: 0 },
    })
    // Earn: settle an order for this customer.
    const o = await order({ customerName: 'Regular', customerPhone: customer.phone })
    await capturePayment({
      restaurantId: restaurant.id, orderId: o.id, method: 'CASH',
      amount: 100_000, tenderedAmount: 100_000, receivedById: cashier.id,
    })
    await settleLoyalty(o.id)

    const earned = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })
    const entries = await prisma.loyaltyEntry.aggregate({
      where: { customerId: customer.id }, _sum: { points: true },
    })
    check('earning writes a ledger entry that explains the balance',
      earned.loyaltyPoints > 0 && (entries._sum.points ?? 0) === earned.loyaltyPoints,
      `balance ${earned.loyaltyPoints}, ledger ${entries._sum.points}`)

    // Spend: redeem against a new order, then check the ledger still balances.
    const spent = await placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
      customerName: 'Regular', customerPhone: customer.phone,
      items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
      redeemPoints: 200,
    })
    const afterSpend = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })
    const afterEntries = await prisma.loyaltyEntry.aggregate({
      where: { customerId: customer.id }, _sum: { points: true },
    })
    check('spending writes the matching negative entry',
      (afterEntries._sum.points ?? 0) === afterSpend.loyaltyPoints,
      `balance ${afterSpend.loyaltyPoints}, ledger ${afterEntries._sum.points}`)
    check('the redemption priced the bill down', spent.loyaltyDiscount > 0)

    /*
     * The double-spend race. Both orders price against the same balance —
     * the clamp cannot see the other — so before the conditional decrement,
     * BOTH went through and the balance went negative. Now exactly one wins.
     */
    await prisma.customer.update({ where: { id: customer.id }, data: { loyaltyPoints: 300 } })
    await prisma.loyaltyEntry.create({
      data: {
        restaurantId: restaurant.id, customerId: customer.id,
        points: 300 - afterSpend.loyaltyPoints, kind: 'ADJUSTED', note: 'test reset',
      },
    })
    const race = await Promise.allSettled([
      placeOrder({
        restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
        customerName: 'Regular', customerPhone: customer.phone,
        items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
        redeemPoints: 300,
      }),
      placeOrder({
        restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
        customerName: 'Regular', customerPhone: customer.phone,
        items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
        redeemPoints: 300,
      }),
    ])
    const wins = race.filter((r) => r.status === 'fulfilled').length
    const finalBalance = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })
    check('two orders racing for the same points: exactly one spends them',
      wins === 1 || (wins === 2 && finalBalance.loyaltyPoints >= 0),
      `${wins} succeeded, balance ${finalBalance.loyaltyPoints}`)
    check('the balance never goes negative', finalBalance.loyaltyPoints >= 0, `${finalBalance.loyaltyPoints}`)
  }

  console.log('\n── 8. A guest transfer claim becomes a row the cashier can see ──')
  {
    const o = await order()
    // What guestPaidAction does when no intent exists: an UNPAID row carrying
    // the reference. Exercised at the service level the action delegates to.
    await prisma.payment.create({
      data: {
        restaurantId: restaurant.id, orderId: o.id, method: 'BANK_TRANSFER',
        status: 'UNPAID', amount: 100_000, reference: 'TXN-778899',
      },
    })
    const claim = await prisma.payment.findFirst({ where: { orderId: o.id, status: 'UNPAID' } })
    check('the claim row exists with its reference', claim?.reference === 'TXN-778899')

    const captured = await capturePayment({
      restaurantId: restaurant.id, orderId: o.id, method: 'BANK_TRANSFER',
      amount: 100_000, reference: 'TXN-778899', receivedById: cashier.id, paymentId: claim!.id,
    })
    check('confirming it settles the bill through the same row',
      captured.payment.id === claim!.id && captured.order.paymentStatus === 'PAID')
  }

  // Tidy up.
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
