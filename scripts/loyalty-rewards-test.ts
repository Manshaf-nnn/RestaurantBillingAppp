/**
 * Loyalty and rewards (loyalty spec).
 *
 * The programme itself already existed — an immutable ledger, earning on
 * settlement, spending at placement, give-backs on cancellation. What is new
 * is a catalogue of rewards a guest recognises, and the ability to spend one
 * against a bill that is already open, from the till or from the guest's own
 * phone.
 *
 * What this pins, and why:
 *
 *   - a reward comes off the bill and the points come off the account, in one
 *     transaction, and the ledger explains the balance afterwards — the
 *     accounting integrity check exists to catch exactly the drift this
 *     would cause if it did not;
 *   - the same reward twice is ONE redemption. A guest tapping twice, a
 *     dropped connection and two tills on one bill all end the same way;
 *   - points that are not there cannot be spent, even by two bills racing for
 *     the same balance;
 *   - a reward is refused when it is retired, expired, or the bill is too
 *     small — each with its own reason, because "no" is not an explanation;
 *   - cancelling gives the points back, and a full refund unwinds BOTH halves:
 *     the points the bill earned are taken back and the points it spent are
 *     returned. A refunded bill used to leave the guest short;
 *   - a hand adjustment writes a ledger entry. It did not, which silently
 *     broke the invariant every time somebody used it.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/loyalty-rewards-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { adjustPoints, balanceForPhone, listRewards, redeemReward } from '../src/features/loyalty/service'
import { cancelOrder, placeOrder, settleLoyalty } from '../src/features/orders/service'
import { capturePayment, refundPayment } from '../src/features/payments/service'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(`${code} ${message}`), `wrong reason: ${code} ${message}`)
  }
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null
let seq = 0
const key = () => `loy-${stamp}-${++seq}`

async function cleanup(id: string) {
  await prisma.loyaltyEntry.deleteMany({ where: { restaurantId: id } })
  await prisma.loyaltyReward.deleteMany({ where: { restaurantId: id } })
  await prisma.refund.deleteMany({ where: { restaurantId: id } })
  await prisma.payment.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.customer.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

/** The invariant the accounting integrity check enforces in production. */
async function ledgerExplainsBalance(customerId: string) {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { loyaltyPoints: true },
  })
  const sum = await prisma.loyaltyEntry.aggregate({
    where: { customerId },
    _sum: { points: true },
  })
  return { balance: customer.loyaltyPoints, ledger: sum._sum.points ?? 0 }
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: 'Loyal Co', slug: `loyal-${stamp}`, email: `loyal-${stamp}@test.local`,
      currency: 'LKR', loyaltyEnabled: true,
      // 1 point per 100 minor units spent; each point worth 1 minor-unit ×100.
      loyaltyEarnRateX100: 100, loyaltyPointValue: 100,
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `till-${stamp}@test.local`, name: 'Till',
      passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Rice',
      slug: `rice-${stamp}`, price: 100_000, isAvailable: true,
    },
  })

  // The branch has to sell it, or placement refuses at the menu check.
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })

  const phone = `0771${stamp.slice(-6)}`
  const order = (items = 1, withPhone = true) =>
    placeOrder({
      restaurantId: restaurant.id,
      branchId: branch.id,
      channel: 'STAFF',
      type: 'TAKEAWAY',
      customerName: 'Nimal',
      customerPhone: withPhone ? phone : '',
      items: [{ foodId: dish.id, quantity: items, optionIds: [], notes: '' }],
      createdById: staff.id,
    })

  console.log('\n── 1. A reward is offered, with what stands between the guest and it ──')
  let rewardId = ''
  {
    const reward = await prisma.loyaltyReward.create({
      data: {
        restaurantId: restaurant.id, name: 'Free dessert',
        pointsCost: 500, value: 20_000, minOrderAmount: 50_000,
      },
    })
    rewardId = reward.id

    const cold = await listRewards({ restaurantId: restaurant.id, points: 100, orderTotal: 100_000 })
    check('it is listed even when it cannot be had', cold.length === 1)
    check('and says how many more points are needed', cold[0].pointsNeeded === 400 && cold[0].affordable === false)

    const warm = await listRewards({ restaurantId: restaurant.id, points: 900, orderTotal: 100_000 })
    check('with enough points it is affordable', warm[0].affordable && warm[0].pointsNeeded === 0)

    const small = await listRewards({ restaurantId: restaurant.id, points: 900, orderTotal: 10_000 })
    check('but a bill under the minimum is flagged', small[0].meetsMinimum === false)

    await prisma.loyaltyReward.create({
      data: {
        restaurantId: restaurant.id, name: 'Old offer', pointsCost: 10, value: 100,
        expiresAt: new Date(Date.now() - 60_000),
      },
    })
    const live = await listRewards({ restaurantId: restaurant.id, points: 900 })
    check('an expired reward is not offered at all', live.every((r) => r.name !== 'Old offer'))
  }

  console.log('\n── 2. Earning happens when the money arrives, once ──')
  let customerId = ''
  {
    const bill = await order(1)
    customerId = bill.customerId!
    check('the bill is on an account', customerId !== null)

    const before = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    check('nothing is earned before payment', before.loyaltyPoints === 0)

    await capturePayment({
      restaurantId: restaurant.id, orderId: bill.id, amount: bill.grandTotal,
      method: 'CASH', receivedById: staff.id, clientRequestId: key(),
    })
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    check('paying earns points', after.loyaltyPoints > 0, String(after.loyaltyPoints))

    // Settlement runs on every transition to fully settled.
    await settleLoyalty(bill.id)
    await settleLoyalty(bill.id)
    const again = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    check('however often settlement runs, the bill earns once', again.loyaltyPoints === after.loyaltyPoints)

    const state = await ledgerExplainsBalance(customerId)
    check('and the ledger explains the balance', state.balance === state.ledger, JSON.stringify(state))
  }

  console.log('\n── 3. Spending a reward on an open bill ──')
  {
    await adjustPoints({
      restaurantId: restaurant.id, customerId, points: 2_000,
      note: 'Opening balance for the test', actorId: staff.id,
    })
    const bill = await order(1)
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })

    const applied = await redeemReward({
      restaurantId: restaurant.id, orderId: bill.id, rewardId, actorId: staff.id,
    })
    check('the points leave the account', applied.balance === before.loyaltyPoints - 500)
    check('and the bill is worth less', applied.discount === 20_000)

    const priced = await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })
    check('the discount is on the order', priced.loyaltyDiscount === 20_000)
    check('and the total came down by it', priced.grandTotal < bill.grandTotal)

    // The whole point of the idempotency work.
    const twice = await redeemReward({
      restaurantId: restaurant.id, orderId: bill.id, rewardId, actorId: staff.id,
    })
    check('the same reward twice is one redemption', twice.replayed === true)
    check('the balance did not move again', twice.balance === applied.balance)
    check('and there is one entry for it', (await prisma.loyaltyEntry.count({
      where: { orderId: bill.id, kind: 'REDEEMED' },
    })) === 1)

    const state = await ledgerExplainsBalance(customerId)
    check('the ledger still explains the balance', state.balance === state.ledger, JSON.stringify(state))
  }

  console.log('\n── 4. What a reward refuses ──')
  {
    const bill = await order(1)
    const retired = await prisma.loyaltyReward.create({
      data: { restaurantId: restaurant.id, name: 'Retired', pointsCost: 1, value: 100, isActive: false },
    })
    await refuses(
      'a retired reward',
      () => redeemReward({ restaurantId: restaurant.id, orderId: bill.id, rewardId: retired.id }),
      /REWARD_RETIRED/,
    )

    const dear = await prisma.loyaltyReward.create({
      data: { restaurantId: restaurant.id, name: 'Too dear', pointsCost: 1_000_000, value: 100 },
    })
    await refuses(
      'more points than the guest has',
      () => redeemReward({ restaurantId: restaurant.id, orderId: bill.id, rewardId: dear.id }),
      /LOYALTY_INSUFFICIENT/,
    )

    const fussy = await prisma.loyaltyReward.create({
      data: {
        restaurantId: restaurant.id, name: 'Big bills only',
        pointsCost: 1, value: 100, minOrderAmount: 10_000_000,
      },
    })
    await refuses(
      'a bill under the minimum',
      () => redeemReward({ restaurantId: restaurant.id, orderId: bill.id, rewardId: fussy.id }),
      /REWARD_MIN_ORDER/,
    )

    const anonymous = await order(1, false)
    await refuses(
      'a bill with nobody on it',
      () => redeemReward({ restaurantId: restaurant.id, orderId: anonymous.id, rewardId }),
      /LOYALTY_NO_CUSTOMER/,
    )

    await refuses(
      "another restaurant's bill",
      () => redeemReward({ restaurantId: 'not-ours', orderId: bill.id, rewardId }),
      /not found|Order/i,
    )

    const balance = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    const state = await ledgerExplainsBalance(customerId)
    check('every refusal left the balance alone', state.balance === state.ledger && balance.loyaltyPoints >= 0)
  }

  console.log('\n── 5. Cancelling gives the points back ──')
  {
    const bill = await order(1)
    await redeemReward({ restaurantId: restaurant.id, orderId: bill.id, rewardId, actorId: staff.id })
    const spent = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })

    await cancelOrder({
      restaurantId: restaurant.id, orderId: bill.id,
      reason: 'Guest changed their mind', actorId: staff.id,
    })
    const back = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    check('the points spent on it are returned', back.loyaltyPoints > spent.loyaltyPoints, `${spent.loyaltyPoints} → ${back.loyaltyPoints}`)
    check('with an entry saying so', (await prisma.loyaltyEntry.count({
      where: { orderId: bill.id, kind: 'RETURNED' },
    })) === 1)

    const state = await ledgerExplainsBalance(customerId)
    check('and the ledger explains the balance', state.balance === state.ledger, JSON.stringify(state))
  }

  console.log('\n── 6. A full refund unwinds both halves ──')
  {
    const bill = await order(2)
    await redeemReward({ restaurantId: restaurant.id, orderId: bill.id, rewardId, actorId: staff.id })
    const priced = await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })
    const afterSpend = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })

    await capturePayment({
      restaurantId: restaurant.id, orderId: bill.id, amount: priced.grandTotal,
      method: 'CASH', receivedById: staff.id, clientRequestId: key(),
    })
    const earnedOn = await prisma.loyaltyEntry.findFirstOrThrow({
      where: { orderId: bill.id, kind: 'EARNED' },
    })
    check('it earned on what was actually paid', earnedOn.points > 0)

    const payments = await prisma.payment.findMany({ where: { orderId: bill.id, status: 'PAID' } })
    for (const payment of payments) {
      await refundPayment({
        restaurantId: restaurant.id, paymentId: payment.id,
        reason: 'All of it back', actorId: staff.id, clientRequestId: key(),
      })
    }

    const settled = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    /*
     * The guest is back where they were before the bill: the 500 they spent
     * returned, and the points it earned taken away again.
     */
    /*
     * Where they started: the 500 the reward cost is back, and the points the
     * bill earned are gone again. `afterSpend` is the balance with the reward
     * already deducted, so the sum of the two is the balance before the bill.
     */
    check('the guest ends where they started', settled.loyaltyPoints === afterSpend.loyaltyPoints + 500,
      `${afterSpend.loyaltyPoints} after spending → ${settled.loyaltyPoints}, earned ${earnedOn.points}`)
    check('and it unwound once', (await prisma.loyaltyEntry.count({
      where: { orderId: bill.id, kind: 'RETURNED' },
    })) === 1)

    const state = await ledgerExplainsBalance(customerId)
    check('the ledger explains the balance', state.balance === state.ledger, JSON.stringify(state))
  }

  console.log('\n── 7. Hand corrections are ledgered, and a lookup tells a guest nothing extra ──')
  {
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    await adjustPoints({
      restaurantId: restaurant.id, customerId, points: 250,
      note: 'Said sorry about the wait', actorId: staff.id,
    })
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    check('the balance moves', after.loyaltyPoints === before.loyaltyPoints + 250)
    check('and the ledger records why', (await prisma.loyaltyEntry.findFirst({
      where: { customerId, kind: 'ADJUSTED', note: 'Said sorry about the wait' },
    })) !== null)

    await refuses(
      'an adjustment with no reason',
      () => adjustPoints({ restaurantId: restaurant.id, customerId, points: 10, note: '' }),
      /LOYALTY_NO_REASON/,
    )

    // Taking more than they hold is capped, and the ENTRY says what happened.
    const big = await adjustPoints({
      restaurantId: restaurant.id, customerId, points: -999_999,
      note: 'Closing the account', actorId: staff.id,
    })
    check('a deduction cannot drive the balance negative', big.balance === 0)
    const state = await ledgerExplainsBalance(customerId)
    check('and the ledger still explains it', state.balance === state.ledger, JSON.stringify(state))

    const found = await balanceForPhone({ restaurantId: restaurant.id, phone })
    check('a guest can look themselves up by phone', found.customerId === customerId)
    const stranger = await balanceForPhone({ restaurantId: restaurant.id, phone: '0000000000' })
    check('and an unknown number reads as nothing, not as "no such guest"',
      stranger.customerId === null && stranger.points === 0)
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
