/**
 * Where the money is allocated (bill.md §2).
 *
 * TableFlow has no gateway and no bank API, so a "destination" is a
 * bookkeeping decision and nothing more: it records which account the owner
 * considers a payment to have landed in. The rules worth holding are the ones
 * that keep that record honest —
 *
 *   • a payment that cannot be placed is refused rather than recorded loose,
 *   • each half of a split carries its own destination,
 *   • a refund goes back where the money came from,
 *   • renaming an account never rewrites what already happened.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/payment-destination-test.ts
 */
import { capturePayment, refundPayment, readPaymentConfig, destinationName } from '../src/features/payments/service'
import { placeOrder } from '../src/features/orders/service'
import { prisma } from '../src/server/db/prisma'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
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

/** Two real banks, the way an owner would set it up. */
const CONFIGURED = {
  cash: true,
  card: true,
  destinations: [
    { code: 'boc', name: 'BOC', kind: 'BANK' },
    { code: 'hnb', name: 'HNB', kind: 'BANK' },
    { code: 'ndb', name: 'NDB', kind: 'BANK', archived: true },
  ],
  methodDestinations: { CASH: 'boc', CARD: 'hnb', QR: 'ndb' },
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Dest ${stamp}`, slug: `dest-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
      paymentConfig: CONFIGURED,
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `till-${stamp}@test.local`,
      name: 'Till', passwordHash: 'x', role: 'CASHIER',
    },
  })
  const dish = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 150_000 },
  })

  // A dish has to be on the branch's menu before it can be rung up there.
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, foodId: dish.id, branchId: branch.id, isAvailable: true },
  })

  const newOrder = async () =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId: null,
      type: 'COUNTER', channel: 'COUNTER', customerName: 'Walk-in', customerPhone: '',
      items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
    })

  console.log('\n── 1. A payment is stamped where the owner pointed it ──')
  {
    const order = await newOrder()
    const paid = await capturePayment({
      restaurantId: restaurant.id, orderId: order.id, method: 'CASH', amount: order.grandTotal,
    })
    check('cash lands on BOC, by code not by name', paid.payment.destination === 'boc', `${paid.payment.destination}`)
  }

  console.log('\n── 2. A method nobody assigned is refused, and records nothing ──')
  {
    const order = await newOrder()
    const before = await prisma.payment.count({ where: { orderId: order.id } })
    await refuses(
      'settling on an unassigned method is refused, by name, pointing at Settings',
      () => capturePayment({
        restaurantId: restaurant.id, orderId: order.id, method: 'WALLET', amount: order.grandTotal,
      }),
      /Wallet has no accounting destination.*Settings → Payments/s,
    )
    const after = await prisma.payment.count({ where: { orderId: order.id } })
    check('…and no payment row was written', after === before, `${before} → ${after}`)

    await refuses(
      'a retired destination is refused too — it cannot be pulled out from under a till',
      () => capturePayment({
        restaurantId: restaurant.id, orderId: order.id, method: 'QR', amount: order.grandTotal,
      }),
      /no accounting destination/,
    )
  }

  console.log('\n── 3. A split bill: each half goes where its method points ──')
  {
    const order = await newOrder()
    await capturePayment({ restaurantId: restaurant.id, orderId: order.id, method: 'CASH', amount: 100_000 })
    const second = await capturePayment({
      restaurantId: restaurant.id, orderId: order.id, method: 'CARD', amount: 50_000,
    })

    const rows = await prisma.payment.findMany({
      where: { orderId: order.id }, orderBy: { createdAt: 'asc' },
    })
    check('two payments, on two different destinations',
      rows.length === 2 && rows[0].destination === 'boc' && rows[1].destination === 'hnb',
      rows.map((row) => `${row.method}:${row.destination}`).join(' '))
    check('and the bill is settled in full',
      second.fullySettled && rows.reduce((sum, row) => sum + row.amount, 0) === 150_000)

    console.log('\n── 4. A refund goes back where the money came from ──')
    const refunded = await refundPayment({
      restaurantId: restaurant.id, paymentId: rows[1].id, amount: 50_000,
      reason: 'Card charged twice', actorId: staff.id,
    })
    check('the refund inherits the payment it reverses — HNB, not whatever CARD points at today',
      refunded.destination === 'hnb', `${refunded.destination}`)
  }

  console.log('\n── 5. Renaming an account does not rewrite history ──')
  {
    const before = await prisma.payment.findMany({
      where: { restaurantId: restaurant.id }, select: { id: true, destination: true },
    })
    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: {
        paymentConfig: {
          ...CONFIGURED,
          destinations: [
            { code: 'boc', name: 'Bank of Ceylon — current', kind: 'BANK' },
            { code: 'hnb', name: 'HNB', kind: 'BANK' },
            { code: 'ndb', name: 'NDB', kind: 'BANK', archived: true },
          ],
        },
      },
    })
    const after = await prisma.payment.findMany({
      where: { restaurantId: restaurant.id }, select: { id: true, destination: true },
    })
    check('every stamped code is untouched',
      JSON.stringify(before) === JSON.stringify(after))

    const renamed = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurant.id } })
    check('…while the label everyone reads follows the rename',
      destinationName(readPaymentConfig(renamed.paymentConfig), 'boc') === 'Bank of Ceylon — current')
  }

  console.log('\n── 6. A restaurant nobody configured keeps trading ──')
  {
    const plain = await prisma.restaurant.create({
      data: {
        name: `Plain ${stamp}`, slug: `plaind-${stamp}`, status: 'ACTIVE', isActive: true,
        currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      },
    })
    const plainBranch = await prisma.branch.create({
      data: { restaurantId: plain.id, name: 'Main', code: 'MAIN', isDefault: true },
    })
    const plainDish = await prisma.food.create({
      data: {
        restaurantId: plain.id,
        categoryId: (await prisma.category.create({
          data: { restaurantId: plain.id, name: 'Mains', slug: `m-${stamp}` },
        })).id,
        name: 'Tea', slug: `tea-${stamp}`, price: 10_000,
      },
    })
    await prisma.foodBranch.create({
      data: { restaurantId: plain.id, foodId: plainDish.id, branchId: plainBranch.id, isAvailable: true },
    })
    const order = await placeOrder({
      restaurantId: plain.id, branchId: plainBranch.id, tableId: null,
      type: 'COUNTER', channel: 'COUNTER', customerName: 'Walk-in', customerPhone: '',
      items: [{ foodId: plainDish.id, quantity: 1, optionIds: [] }],
    })
    const paid = await capturePayment({
      restaurantId: plain.id, orderId: order.id, method: 'CASH', amount: order.grandTotal,
    })
    check('never opening the setting is not the same as switching a method off',
      paid.payment.destination === 'cash', `${paid.payment.destination}`)

    await prisma.restaurant.delete({ where: { id: plain.id } })
  }

  console.log('\n── 7. The report groups the same money two ways ──')
  {
    const { getPaymentsReport } = await import('../src/features/reports/sales')
    const { resolveRange } = await import('../src/features/reports/range')
    const report = await getPaymentsReport({
      restaurantId: restaurant.id,
      range: resolveRange({ preset: 'TODAY', timeZone: 'Asia/Colombo' }),
    })

    const byMethod = report.byMethod.reduce((sum, row) => sum + row.amount, 0)
    const byDestination = report.byDestination.reduce((sum, row) => sum + row.amount, 0)
    check('by method and by destination sum to the same figure',
      byMethod === byDestination && byMethod === report.total,
      `${byMethod} vs ${byDestination} vs ${report.total}`)

    check('destinations are labelled by their current name',
      report.byDestination.some((row) => row.label === 'Bank of Ceylon — current'),
      report.byDestination.map((row) => row.label).join(', '))

    // A payment from before destinations existed.
    const order = await newOrder()
    const legacy = await capturePayment({
      restaurantId: restaurant.id, orderId: order.id, method: 'CASH', amount: order.grandTotal,
    })
    await prisma.payment.update({ where: { id: legacy.payment.id }, data: { destination: null } })
    const withLegacy = await getPaymentsReport({
      restaurantId: restaurant.id,
      range: resolveRange({ preset: 'TODAY', timeZone: 'Asia/Colombo' }),
    })
    check('a payment with no destination reads as Unassigned, not dropped',
      withLegacy.byDestination.some((row) => row.destination === null && row.label === 'Unassigned') &&
        withLegacy.byDestination.reduce((sum, row) => sum + row.amount, 0) === withLegacy.total)
  }

  console.log('\n── 8. The settings form cannot save a map the till would choke on ──')
  {
    const { paymentDestinationsSchema } = await import('../src/features/settings/schema')
    const { slugifyDestinationCode } = await import('../src/features/payments/destinations')

    const good = paymentDestinationsSchema.safeParse({
      destinations: [{ code: 'boc', name: 'BOC', kind: 'BANK', archived: false }],
      methodDestinations: { CASH: 'boc', CARD: '' },
    })
    check('a sound map saves — including a method deliberately left unbooked', good.success,
      JSON.stringify(good.success ? null : good.error.issues))

    const dangling = paymentDestinationsSchema.safeParse({
      destinations: [{ code: 'boc', name: 'BOC', kind: 'BANK', archived: false }],
      methodDestinations: { CASH: 'hnb' },
    })
    check('pointing a method at an account that does not exist is refused',
      !dangling.success, 'it saved')

    const retired = paymentDestinationsSchema.safeParse({
      destinations: [{ code: 'boc', name: 'BOC', kind: 'BANK', archived: true }],
      methodDestinations: { CASH: 'boc' },
    })
    check('…and so is pointing one at an account that was just retired',
      !retired.success, 'it saved')

    const twins = paymentDestinationsSchema.safeParse({
      destinations: [
        { code: 'boc', name: 'BOC', kind: 'BANK', archived: false },
        { code: 'boc', name: 'BOC savings', kind: 'BANK', archived: false },
      ],
      methodDestinations: {},
    })
    check('two accounts cannot share one code — that is what a payment stamps',
      !twins.success, 'it saved')

    const blank = paymentDestinationsSchema.safeParse({
      destinations: [{ code: 'boc', name: '   ', kind: 'BANK', archived: false }],
      methodDestinations: {},
    })
    check('an account with no name is refused', !blank.success, 'it saved')

    check('a code is minted from the name, and never collides',
      slugifyDestinationCode('Bank of Ceylon — Current') === 'bank_of_ceylon_current' &&
        slugifyDestinationCode('BOC', ['boc']) === 'boc_2' &&
        slugifyDestinationCode('!!!') === 'account')
  }

  console.log('\n── 9. Bank details: optional going in, intact coming out ──')
  {
    const { paymentDestinationsSchema } = await import('../src/features/settings/schema')
    const { destinationDetailLine } = await import('../src/features/payments/destinations')

    const full = paymentDestinationsSchema.safeParse({
      destinations: [{
        code: 'boc', name: 'BOC current', kind: 'BANK',
        bankName: 'Bank of Ceylon', accountNumber: '0012345678',
        holderName: 'Nila Foods (Pvt) Ltd', bankBranch: 'Colombo 07',
      }],
      methodDestinations: { CASH: 'boc' },
    })
    check('an account with full bank details saves', full.success,
      JSON.stringify(full.success ? null : full.error.issues))

    const bare = paymentDestinationsSchema.safeParse({
      destinations: [{ code: 'tin', name: 'The cash tin', kind: 'CASH' }],
      methodDestinations: { CASH: 'tin' },
    })
    check('…and so does one with none of them — every bank field is optional',
      bare.success, JSON.stringify(bare.success ? null : bare.error.issues))

    const gateway = paymentDestinationsSchema.safeParse({
      destinations: [{ code: 'stripe', name: 'Stripe payouts', kind: 'GATEWAY' }],
      methodDestinations: {},
    })
    check('a gateway account is already expressible, for the day there is one',
      gateway.success)

    check('the one-line summary is built from whatever was filled in',
      destinationDetailLine({
        code: 'boc', name: 'BOC',
        bankName: 'Bank of Ceylon', accountNumber: '0012345678', bankBranch: 'Colombo 07',
      }) === 'Bank of Ceylon · A/C 0012345678 · Colombo 07')
    check('…and an account with nothing filled in describes itself as nothing, not as separators',
      destinationDetailLine({ code: 'tin', name: 'The cash tin' }) === '')
  }

  console.log('\n── 10. Cash taken at the till is readable under its account ──')
  {
    const { getDestinationTotals, getDestinationPayments } = await import(
      '../src/features/payments/queries'
    )

    const totals = await getDestinationTotals(restaurant.id)
    const boc = totals.find((row) => row.destination === 'boc')
    const hnb = totals.find((row) => row.destination === 'hnb')

    check('BOC holds the cash, HNB holds the card — separately',
      boc !== undefined && hnb !== undefined && boc.collected > 0 && hnb.collected > 0,
      JSON.stringify(totals))

    check('the card refund shows against HNB rather than reducing it out of sight',
      hnb?.refunded === 50_000, `${hnb?.refunded}`)

    /*
     * The figure on this screen and the figure on the payments report are the
     * same money read two ways. If they can disagree, one of them is lying and
     * nobody can tell which — so they are asserted equal here.
     */
    const { getPaymentsReport } = await import('../src/features/reports/sales')
    const { resolveRange } = await import('../src/features/reports/range')
    const report = await getPaymentsReport({
      restaurantId: restaurant.id,
      range: resolveRange({ preset: 'TODAY', timeZone: 'Asia/Colombo' }),
    })
    const screenTotal = totals.reduce((sum, row) => sum + row.collected, 0)
    check('what the accounts screen adds up to is what the report adds up to',
      screenTotal === report.total, `${screenTotal} vs ${report.total}`)

    const inBoc = await getDestinationPayments(restaurant.id, 'boc')
    check('opening BOC lists its own payments and nobody else’s',
      inBoc.length > 0 && inBoc.every((row) => row.method === 'CASH'),
      inBoc.map((row) => row.method).join(','))
    check('…each carrying the order it settled, so it can be traced back',
      inBoc.every((row) => Boolean(row.orderNumber) && Boolean(row.orderId)))

    const legacy = await getDestinationPayments(restaurant.id, null)
    check('the money taken before accounts existed is still reachable, not lost',
      legacy.length > 0)
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
