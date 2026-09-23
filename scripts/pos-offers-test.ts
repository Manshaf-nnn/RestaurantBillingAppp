/**
 * A targeted offer reaches the till, and points can be spent there
 * (pro.A.md §4, §10).
 *
 * ── The loop that was open ──────────────────────────────────────────────────
 *
 * An owner could aim a discount at "regulars who have not been in for a month".
 * The engine enforced it perfectly — for anybody who happened to TYPE the code.
 * Nothing ever told the guest what the code was, and nothing told the cashier
 * either, so a campaign created on the customers screen reached nobody and
 * looked, from the till, exactly like no campaign at all.
 *
 * Section 2 is the one that matters: it asks the question the till now asks —
 * "what can this phone number have?" — and expects the campaign back. Against
 * the old code that list did not exist.
 *
 * ── And the second half ─────────────────────────────────────────────────────
 *
 * Spending points was built twice and wired neither time. `staffOrderSchema`
 * has accepted `redeemPoints` since placement-time redemption was written, and
 * no caller ever sent it; `redeemPoints` in `discounts.ts` had no callers at
 * all. Sections 5 and 6 pin both halves, including the thing that makes them
 * safe to have: the ledger still explains the balance afterwards.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/pos-offers-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { offersForCustomer } from '../src/features/customers/discounts'
import { redeemPointsOnOrder } from '../src/features/loyalty/service'
import { placeOrder } from '../src/features/orders/service'

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
const key = () => `off-${stamp}-${++seq}`

async function cleanup(id: string) {
  await prisma.couponRedemption.deleteMany({ where: { coupon: { restaurantId: id } } })
  await prisma.loyaltyEntry.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.coupon.deleteMany({ where: { restaurantId: id } })
  await prisma.customer.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
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
      name: 'Offers Co', slug: `offers-${stamp}`, email: `offers-${stamp}@test.local`,
      currency: 'LKR', loyaltyEnabled: true,
      // One point per 100 minor units spent; each point worth 100 minor units.
      loyaltyEarnRateX100: 100, loyaltyPointValue: 100,
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KAN' },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `till-${stamp}@test.local`, name: 'Till',
      passwordHash: 'x', role: 'POS', branchId: branch.id,
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
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })

  const regularPhone = `0771${stamp.slice(-6)}`
  const newbiePhone = `0772${stamp.slice(-6)}`

  const order = (opts: { phone: string; items?: number; couponCode?: string; redeemPoints?: number }) =>
    placeOrder({
      restaurantId: restaurant.id,
      branchId: branch.id,
      channel: 'STAFF',
      type: 'TAKEAWAY',
      customerName: 'Guest',
      customerPhone: opts.phone,
      items: [{ foodId: dish.id, quantity: opts.items ?? 1, optionIds: [], notes: '' }],
      createdById: staff.id,
      idempotencyKey: key(),
      ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
      ...(opts.redeemPoints ? { redeemPoints: opts.redeemPoints } : {}),
    })

  console.log('\n── 1. A regular, and somebody on their first visit ──')
  await order({ phone: regularPhone })
  await order({ phone: regularPhone })
  await order({ phone: regularPhone })
  await order({ phone: newbiePhone })

  const regular = await prisma.customer.findFirstOrThrow({
    where: { restaurantId: restaurant.id, phone: regularPhone },
  })
  const newbie = await prisma.customer.findFirstOrThrow({
    where: { restaurantId: restaurant.id, phone: newbiePhone },
  })
  check('the regular has three visits', regular.totalOrders === 3, String(regular.totalOrders))
  check('the newcomer has one', newbie.totalOrders === 1, String(newbie.totalOrders))

  console.log('\n── 2. An offer aimed at regulars reaches the till ──')
  const campaign = await prisma.coupon.create({
    data: {
      restaurantId: restaurant.id,
      code: `REGULARS-${stamp.slice(-4).toUpperCase()}`,
      description: '10% off for regulars',
      type: 'PERCENT',
      value: 1_000,
      // The saved filter, exactly as the customers screen writes it.
      segment: { minVisits: 3 },
      isActive: true,
    },
  })

  const basket = [{ foodId: dish.id, categoryId: category.id, quantity: 1, lineTotal: 100_000 }]

  {
    const offers = await offersForCustomer({
      restaurantId: restaurant.id,
      customerId: regular.id,
      branchId: branch.id,
      subtotal: 100_000,
      lines: basket,
    })
    const found = offers.find((offer) => offer.id === campaign.id)
    // Written to fail against the old code, where no such list existed.
    check('the regular is shown the offer', found !== undefined)
    check('marked usable', found?.ok === true, found?.reason)
    check('with what it takes off this basket', found?.amount === 10_000, String(found?.amount))
    check('and described, not just coded', found?.description === '10% off for regulars')
  }

  {
    const offers = await offersForCustomer({
      restaurantId: restaurant.id,
      customerId: newbie.id,
      branchId: branch.id,
      subtotal: 100_000,
      lines: basket,
    })
    check(
      'the newcomer is not shown it at all',
      offers.every((offer) => offer.id !== campaign.id),
      offers.map((offer) => offer.code).join(', '),
    )
  }

  console.log('\n── 3. The list and the till agree, because it is one evaluator ──')
  {
    const placed = await order({ phone: regularPhone, couponCode: campaign.code })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })
    check('placement accepts the offer the list showed', row.couponDiscount === 10_000, String(row.couponDiscount))

    // And refuses it for somebody the list refused.
    await refuses(
      'and refuses it for the newcomer',
      () => order({ phone: newbiePhone, couponCode: campaign.code }),
      /COUPON_INVALID|not for this customer/i,
    )
  }

  console.log('\n── 4. A near miss is shown WITH its reason, not hidden ──')
  {
    const bigSpend = await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id,
        code: `BIG-${stamp.slice(-4).toUpperCase()}`,
        description: 'Rs 500 off over Rs 5,000',
        type: 'FIXED',
        value: 50_000,
        minOrderAmount: 500_000,
        segment: { minVisits: 3 },
        isActive: true,
      },
    })
    const offers = await offersForCustomer({
      restaurantId: restaurant.id,
      customerId: regular.id,
      branchId: branch.id,
      subtotal: 100_000,
      lines: basket,
    })
    const near = offers.find((offer) => offer.id === bigSpend.id)
    check('it is listed', near !== undefined)
    check('but not usable yet', near?.ok === false)
    check(
      'and says what would make it usable',
      Boolean(near?.reason?.startsWith('Spend ')),
      near?.reason,
    )

    // Usable offers sort above near misses, so the cashier reads the best first.
    const first = offers.findIndex((offer) => offer.ok)
    const firstBlocked = offers.findIndex((offer) => !offer.ok)
    check('usable ones come first', first < firstBlocked || firstBlocked === -1)

    await prisma.coupon.delete({ where: { id: bigSpend.id } })
  }

  console.log('\n── 5. Another branch’s offer is never shown here ──')
  {
    const elsewhere = await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id,
        code: `KANDY-${stamp.slice(-4).toUpperCase()}`,
        type: 'PERCENT',
        value: 2_000,
        branchId: other.id,
        segment: { minVisits: 3 },
        isActive: true,
      },
    })
    const offers = await offersForCustomer({
      restaurantId: restaurant.id,
      customerId: regular.id,
      branchId: branch.id,
      subtotal: 100_000,
      lines: basket,
    })
    check(
      'a Kandy offer is absent at the Main till',
      offers.every((offer) => offer.id !== elsewhere.id),
    )
    await prisma.coupon.delete({ where: { id: elsewhere.id } })
  }

  console.log('\n── 6. Points spent at placement, from the order column ──')
  {
    /*
     * Points are EARNED at settlement, and these bills were never paid — so
     * the balance is topped up here, through the ledger, exactly as a hand
     * correction would. Spending is what this section is about.
     */
    await prisma.customer.update({ where: { id: regular.id }, data: { loyaltyPoints: 500 } })
    await prisma.loyaltyEntry.create({
      data: {
        restaurantId: restaurant.id, customerId: regular.id,
        points: 500 - (await ledgerExplainsBalance(regular.id)).ledger,
        kind: 'ADJUSTED', note: 'test top-up',
      },
    })

    const before = await prisma.customer.findUniqueOrThrow({
      where: { id: regular.id },
      select: { loyaltyPoints: true },
    })
    check('the regular has points to spend', before.loyaltyPoints > 0, String(before.loyaltyPoints))

    const spend = Math.min(50, before.loyaltyPoints)
    const placed = await order({ phone: regularPhone, redeemPoints: spend })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })

    // Written to fail against the old code: nothing ever sent `redeemPoints`.
    check('the bill carries a loyalty discount', row.loyaltyDiscount > 0, String(row.loyaltyDiscount))
    check(
      'worth the points at the restaurant’s own rate',
      row.loyaltyDiscount === spend * 100,
      `${row.loyaltyDiscount} for ${spend} points`,
    )
    check(
      'and it is NOT folded into the ordinary discount',
      row.discountTotal === row.couponDiscount + row.manualDiscount + row.itemDiscount,
      `${row.discountTotal} vs ${row.couponDiscount + row.manualDiscount + row.itemDiscount}`,
    )

    const after = await ledgerExplainsBalance(regular.id)
    check('the ledger still explains the balance', after.balance === after.ledger, `${after.balance} vs ${after.ledger}`)
  }

  console.log('\n── 7. Points spent on a bill that already exists ──')
  {
    // Give them a known balance to spend from.
    await prisma.customer.update({ where: { id: regular.id }, data: { loyaltyPoints: 1_000 } })
    await prisma.loyaltyEntry.create({
      data: {
        restaurantId: restaurant.id, customerId: regular.id,
        points: 1_000 - (await ledgerExplainsBalance(regular.id)).ledger,
        kind: 'ADJUSTED', note: 'test top-up',
      },
    })

    const placed = await order({ phone: regularPhone, items: 2 })
    const result = await redeemPointsOnOrder({
      restaurantId: restaurant.id,
      orderId: placed.id,
      points: 200,
      actorId: staff.id,
    })
    check('200 points come off', result.pointsSpent === 200, String(result.pointsSpent))
    check('worth 20,000 minor units', result.discount === 20_000, String(result.discount))

    const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })
    check('the bill says so', row.loyaltyDiscount === 20_000, String(row.loyaltyDiscount))
    check('and the total came down with it', row.grandTotal < row.subtotal, `${row.grandTotal} vs ${row.subtotal}`)

    const after = await ledgerExplainsBalance(regular.id)
    check('the ledger still explains the balance', after.balance === after.ledger, `${after.balance} vs ${after.ledger}`)

    // The guards that make it safe to expose.
    await refuses(
      'more points than they hold is refused',
      () => redeemPointsOnOrder({ restaurantId: restaurant.id, orderId: placed.id, points: 99_999 }),
      /LOYALTY_INSUFFICIENT|LOYALTY_NO_ROOM/,
    )
    await refuses(
      'and nothing at all is refused',
      () => redeemPointsOnOrder({ restaurantId: restaurant.id, orderId: placed.id, points: 0 }),
      /LOYALTY_NO_POINTS/,
    )

    const stillSound = await ledgerExplainsBalance(regular.id)
    check(
      'a refused attempt leaves the balance alone',
      stillSound.balance === after.balance,
      `${stillSound.balance} vs ${after.balance}`,
    )
  }

  console.log('\n── 8. Both order forms send it, not just one ──')
  {
    /*
     * The recurring failure on this screen: a customer feature built into the
     * Orders tab and not into the Cashier tab's New order dialog, so the same
     * guest gets a different answer depending on which one the cashier opened.
     */
    const terminal = readFileSync('src/features/cashier/components/pos-terminal.tsx', 'utf8')
    const board = readFileSync('src/features/cashier/components/cashier-board.tsx', 'utf8')

    for (const [name, source] of [['Orders tab', terminal], ['New order dialog', board]] as const) {
      check(`${name} shows the guest panel`, source.includes('<GuestPanel'))
      check(`${name} sends the chosen offer`, /couponCode[:,]/.test(source))
      check(`${name} sends the points`, /redeemPoints[:,]/.test(source))
    }

    // The per-line discount the Orders tab collected and silently dropped.
    check(
      'the Orders tab sends per-line discounts it collected',
      /discount: l\.discount/.test(terminal),
    )
  }

  console.log('\n── 9. An offer needs no code an owner had to invent ──')
  {
    const schema = readFileSync('src/features/customers/schema.ts', 'utf8')
    check(
      'the campaign schema no longer demands one',
      /code:[\s\S]{0,400}?\.optional\(\)/.test(schema),
    )
    const actions = readFileSync('src/features/customers/actions.ts', 'utf8')
    check('and the server names it instead', actions.includes('freeCampaignCode'))
    const dialog = readFileSync('src/features/staff/components/customers-manager.tsx', 'utf8')
    check('so the dialog stopped asking', !dialog.includes('placeholder="REGULARS10"'))
  }
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n  ✗ crashed:', error)
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
