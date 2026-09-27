/**
 * Two tills, one bill: races that carry DIFFERENT idempotency keys.
 *
 * ── Why this exists next to the suites that already cover concurrency ───────
 *
 * `payment-model-test` fires two captures and two refunds at once and proves
 * they settle to one row. Both pairs share a `clientRequestId`, so what they
 * pin is REPLAY — the browser retrying before the first response lands — and
 * the mechanism that saves them is the idempotency lookup.
 *
 * `phase11-test` covers the inventory side: concurrent withdrawals, transfer
 * dispatch, recipe depletion, goods receipt.
 *
 * Neither covers the other direction, and it is the one that actually loses
 * money: two GENUINELY different requests, different keys, arriving at the
 * same moment on the same bill. Idempotency cannot help there, because the
 * requests are not the same request. The only thing standing between that and
 * a double-settled order is the `FOR UPDATE` on the order row, and nothing
 * exercised it.
 *
 * The shape is ordinary in a restaurant: two cashiers on two terminals reach
 * for the same open bill, or a cashier settles while the guest pays by QR.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/concurrency-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { voidOrderItem } from '../src/features/cashier/service'
import { capturePayment, refundPayment } from '../src/features/payments/service'
import { outstandingOn } from '../src/features/orders/pricing'

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

/**
 * How many of a settled batch succeeded, and why the rest did not.
 *
 * Deliberately `unknown` rather than generic: one batch below races a refund
 * against a capture, and those return different shapes. Nothing here reads
 * the fulfilled value — the assertions read the database afterwards, which is
 * the only account of what happened that both writers agree on.
 */
function tally(results: PromiseSettledResult<unknown>[]) {
  const won = results.filter((r) => r.status === 'fulfilled')
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  return {
    won,
    lost,
    reasons: lost.map((r) => String((r.reason as { message?: string })?.message ?? r.reason)),
  }
}

async function main() {
  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Race ${stamp}`,
      slug: `race-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
      taxRateBps: 0,
      serviceChargeBps: 0,
      taxInclusive: false,
    },
  })

  try {
    const branch = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Main', code: `R${stamp.slice(-4)}`, isDefault: true },
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
        email: `race-${stamp}@test.local`,
        name: 'Cashier',
        passwordHash: 'x',
        role: 'CASHIER',
        branchId: branch.id,
      },
    })

    /** A fresh 1000.00 bill. */
    const bill = () =>
      placeOrder({
        restaurantId: restaurant.id,
        branchId: branch.id,
        type: 'TAKEAWAY',
        customerName: 'Walk-in',
        customerPhone: '',
        items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
      })

    const take = (orderId: string, amount: number, method: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET', key: string) =>
      capturePayment({
        restaurantId: restaurant.id,
        orderId,
        method,
        amount,
        ...(method === 'CASH' ? { tenderedAmount: amount } : {}),
        receivedById: cashier.id,
        clientRequestId: key,
      })

    const read = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })

    // ── 1. A split that adds up ──────────────────────────────────────────────
    console.log('\n── 1. Cash + Card + Transfer, summing to the bill ──')
    {
      const o = await bill()
      await take(o.id, 40_000, 'CASH', `s1-${stamp}-a`)
      const mid = await read(o.id)
      check('after the first part the bill is PARTIAL', mid.paymentStatus === 'PARTIAL', mid.paymentStatus)
      check('and outstanding is the remainder', outstandingOn(mid) === 60_000, `${outstandingOn(mid)}`)

      await take(o.id, 35_000, 'CARD', `s1-${stamp}-b`)
      await take(o.id, 25_000, 'BANK_TRANSFER', `s1-${stamp}-c`)

      const done = await read(o.id)
      check('three methods settle the bill exactly', done.paidTotal === 100_000, `${done.paidTotal}`)
      check('and it reads PAID', done.paymentStatus === 'PAID', done.paymentStatus)
      check('with nothing outstanding', outstandingOn(done) === 0, `${outstandingOn(done)}`)
      const rows = await prisma.payment.count({ where: { orderId: o.id } })
      check('as three payment rows', rows === 3, `${rows}`)
    }

    // ── 2. One minor unit too many ───────────────────────────────────────────
    console.log('\n── 2. The bill cannot be overpaid, even by one unit ──')
    {
      const o = await bill()
      await take(o.id, 99_999, 'CASH', `s2-${stamp}-a`)
      const before = await read(o.id)
      check('one unit still outstanding', outstandingOn(before) === 1, `${outstandingOn(before)}`)
      let refused = ''
      await take(o.id, 2, 'CASH', `s2-${stamp}-b`).catch((error) => {
        refused = String(error?.message ?? error)
      })
      check('two units is refused', /more than/i.test(refused), refused || 'accepted')
      const after = await read(o.id)
      check('and nothing was written', after.paidTotal === 99_999, `${after.paidTotal}`)
    }

    // ── 3. The race that idempotency cannot save ─────────────────────────────
    console.log('\n── 3. Two cashiers, two keys, each taking the whole bill ──')
    {
      const o = await bill()
      const results = await Promise.allSettled([
        take(o.id, 100_000, 'CASH', `s3-${stamp}-a`),
        take(o.id, 100_000, 'CARD', `s3-${stamp}-b`),
      ])
      const { won, reasons } = tally(results)
      check('exactly one of them takes the money', won.length === 1, `${won.length} succeeded`)
      check('the other is refused as overpayment', reasons.some((r) => /more than/i.test(r)), reasons.join(' | '))

      const after = await read(o.id)
      check('the bill is paid once, not twice', after.paidTotal === 100_000, `${after.paidTotal}`)
      check('and reads PAID', after.paymentStatus === 'PAID', after.paymentStatus)
      const rows = await prisma.payment.count({ where: { orderId: o.id } })
      check('one payment row exists', rows === 1, `${rows}`)
    }

    // ── 4. A genuine simultaneous split ──────────────────────────────────────
    console.log('\n── 4. Two guests paying half each, at the same moment ──')
    {
      const o = await bill()
      const results = await Promise.allSettled([
        take(o.id, 50_000, 'CASH', `s4-${stamp}-a`),
        take(o.id, 50_000, 'CARD', `s4-${stamp}-b`),
      ])
      const { won, reasons } = tally(results)
      check('both halves are taken', won.length === 2, `${won.length} succeeded: ${reasons.join(' | ')}`)

      const after = await read(o.id)
      check('and they add up to the bill', after.paidTotal === 100_000, `${after.paidTotal}`)
      check('the bill reads PAID', after.paymentStatus === 'PAID', after.paymentStatus)
      const rows = await prisma.payment.count({ where: { orderId: o.id } })
      check('as two rows', rows === 2, `${rows}`)
    }

    // ── 5. Five terminals at once ────────────────────────────────────────────
    console.log('\n── 5. Five simultaneous fifths ──')
    {
      const o = await bill()
      const results = await Promise.allSettled(
        [0, 1, 2, 3, 4].map((n) => take(o.id, 20_000, 'CASH', `s5-${stamp}-${n}`)),
      )
      const { won } = tally(results)
      check('all five commit', won.length === 5, `${won.length}/5`)
      const after = await read(o.id)
      check('the arithmetic survives five writers', after.paidTotal === 100_000, `${after.paidTotal}`)
      check('and the bill is not overpaid', outstandingOn(after) === 0, `${outstandingOn(after)}`)
    }

    // ── 6. Six at once, where only five fit ──────────────────────────────────
    console.log('\n── 6. Six fifths offered, five fit ──')
    {
      const o = await bill()
      const results = await Promise.allSettled(
        [0, 1, 2, 3, 4, 5].map((n) => take(o.id, 20_000, 'CASH', `s6-${stamp}-${n}`)),
      )
      const { won, reasons } = tally(results)
      check('five are taken and the sixth refused', won.length === 5, `${won.length} succeeded`)
      check('the refusal names overpayment', reasons.some((r) => /more than/i.test(r)), reasons.join(' | '))
      const after = await read(o.id)
      check('the till is not over by one fifth', after.paidTotal === 100_000, `${after.paidTotal}`)
    }

    // ── 7. Refunds racing on different keys ──────────────────────────────────
    console.log('\n── 7. Two full refunds of one payment, at once ──')
    {
      const o = await bill()
      const cap = await take(o.id, 100_000, 'CASH', `s7-${stamp}-cap`)
      const results = await Promise.allSettled([
        refundPayment({
          restaurantId: restaurant.id, paymentId: cap.payment.id, reason: 'Race A',
          actorId: cashier.id, amount: 100_000, clientRequestId: `s7-${stamp}-a`,
        }),
        refundPayment({
          restaurantId: restaurant.id, paymentId: cap.payment.id, reason: 'Race B',
          actorId: cashier.id, amount: 100_000, clientRequestId: `s7-${stamp}-b`,
        }),
      ])
      const { won, reasons } = tally(results)
      check('only one refund goes out', won.length === 1, `${won.length} succeeded`)
      check('the second is refused', reasons.length === 1, reasons.join(' | '))

      const back = await prisma.refund.aggregate({
        where: { paymentId: cap.payment.id },
        _sum: { amount: true },
      })
      check('the guest gets their money back once', back._sum.amount === 100_000, `${back._sum.amount}`)
      const after = await read(o.id)
      check('and the bill shows nothing paid', after.paidTotal === 0, `${after.paidTotal}`)
    }

    // ── 8. Partial refunds racing, then one too many ─────────────────────────
    console.log('\n── 8. Two halves back at once, then a third ──')
    {
      const o = await bill()
      const cap = await take(o.id, 100_000, 'CASH', `s8-${stamp}-cap`)
      const results = await Promise.allSettled([
        refundPayment({
          restaurantId: restaurant.id, paymentId: cap.payment.id, reason: 'Half A',
          actorId: cashier.id, amount: 50_000, clientRequestId: `s8-${stamp}-a`,
        }),
        refundPayment({
          restaurantId: restaurant.id, paymentId: cap.payment.id, reason: 'Half B',
          actorId: cashier.id, amount: 50_000, clientRequestId: `s8-${stamp}-b`,
        }),
      ])
      const { won } = tally(results)
      check('both halves go back', won.length === 2, `${won.length}/2`)
      const back = await prisma.refund.aggregate({
        where: { paymentId: cap.payment.id },
        _sum: { amount: true },
      })
      check('and together they equal what was taken', back._sum.amount === 100_000, `${back._sum.amount}`)

      let refused = ''
      await refundPayment({
        restaurantId: restaurant.id, paymentId: cap.payment.id, reason: 'One too many',
        actorId: cashier.id, amount: 1, clientRequestId: `s8-${stamp}-c`,
      }).catch((error) => {
        refused = String(error?.message ?? error)
      })
      check('a third refund is refused', refused.length > 0, refused || 'accepted')
      const still = await prisma.refund.aggregate({
        where: { paymentId: cap.payment.id },
        _sum: { amount: true },
      })
      check('and gave nothing extra away', still._sum.amount === 100_000, `${still._sum.amount}`)
    }

    // ── 9. A refund larger than the payment ──────────────────────────────────
    console.log('\n── 9. Refunding more than was ever captured ──')
    {
      const o = await bill()
      const cap = await take(o.id, 40_000, 'CASH', `s9-${stamp}-cap`)
      let refused = ''
      await refundPayment({
        restaurantId: restaurant.id, paymentId: cap.payment.id, reason: 'Too much',
        actorId: cashier.id, amount: 40_001, clientRequestId: `s9-${stamp}-a`,
      }).catch((error) => {
        refused = String(error?.message ?? error)
      })
      check('refused, naming what can go back', /can go back/i.test(refused), refused || 'accepted')
      const back = await prisma.refund.count({ where: { paymentId: cap.payment.id } })
      check('and no refund row was written', back === 0, `${back}`)
    }

    // ── 10. Settling a bill while it is being refunded ───────────────────────
    console.log('\n── 10. A refund and a fresh payment crossing on one bill ──')
    {
      const o = await bill()
      const cap = await take(o.id, 100_000, 'CASH', `s10-${stamp}-cap`)
      const results = await Promise.allSettled([
        refundPayment({
          restaurantId: restaurant.id, paymentId: cap.payment.id, reason: 'Crossing',
          actorId: cashier.id, amount: 100_000, clientRequestId: `s10-${stamp}-r`,
        }),
        take(o.id, 100_000, 'CARD', `s10-${stamp}-p`),
      ])
      const { won } = tally(results)
      const after = await read(o.id)
      /*
       * Every payment row on the bill, whatever status it ended in — a
       * payment that was refunded still happened, and `paidTotal` is defined
       * as what came in less what went back, not as what is left unrefunded.
       * Filtering the captures by status here would make the identity below
       * true by construction and the assertion worthless.
       */
      const captured = await prisma.payment.aggregate({
        where: { orderId: o.id },
        _sum: { amount: true },
      })
      const returned = await prisma.refund.aggregate({
        where: { payment: { orderId: o.id } },
        _sum: { amount: true },
      })
      const held = (captured._sum.amount ?? 0) - (returned._sum.amount ?? 0)
      /*
       * Either order of arrival is legitimate — a refund landing before the
       * card payment, or after it. What must hold in BOTH is the identity:
       * the bill says it holds exactly the money that came in less the money
       * that went back, and never more than the bill itself.
       */
      check(
        'whatever order they land in, paidTotal never exceeds the bill',
        after.paidTotal <= 100_000,
        `paidTotal=${after.paidTotal} won=${won.length}`,
      )
      check(
        'and paidTotal is exactly what came in less what went back',
        after.paidTotal === held,
        `paid=${after.paidTotal} captured=${captured._sum.amount} returned=${returned._sum.amount} held=${held}`,
      )
      check('the bill is never left owing a negative amount', outstandingOn(after) >= 0, `${outstandingOn(after)}`)
    }
    // ── 11. Four people on one bill at the same moment ──────────────────────
    console.log('\n── 11. A cashier, a second till, a manager and the kitchen, at once ──')
    {
      /*
       * The scenario `perfect.md` §10 names, and the one where money can
       * actually disappear: a manager voids a line while a cashier is taking
       * money for it. Voiding reduces `grandTotal`, so a bill can end up
       * having collected more than it is now worth — which the service guards
       * against explicitly, because when it happened the overpayment "appeared
       * in no report, produced no refund and showed on no screen".
       *
       * Any interleaving is legitimate; some of these four will lose. What is
       * asserted is what must be true AFTERWARDS, whichever order they landed
       * in — so this is a test about invariants, not about a winner.
       */
      const o = await placeOrder({
        restaurantId: restaurant.id,
        branchId: branch.id,
        type: 'TAKEAWAY',
        customerName: 'Walk-in',
        customerPhone: '',
        items: [
          { foodId: dish.id, quantity: 1, optionIds: [] },
          { foodId: dish.id, quantity: 1, optionIds: [] },
        ],
      })
      const lines = await prisma.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
      check('the bill starts at two lines, 2000.00', o.grandTotal === 200_000, `${o.grandTotal}`)

      const results = await Promise.allSettled([
        take(o.id, 100_000, 'CASH', `s11-${stamp}-a`),
        take(o.id, 100_000, 'CARD', `s11-${stamp}-b`),
        voidOrderItem({
          restaurantId: restaurant.id, orderId: o.id, itemId: lines[0].id,
          reason: 'Sent back', actorId: cashier.id, actorName: cashier.name,
        }),
        updateOrderStatus({
          restaurantId: restaurant.id, orderId: o.id, status: 'PREPARING',
          actorId: cashier.id, actorName: cashier.name,
        }),
      ])
      const { won, reasons } = tally(results)
      console.log(`    ${won.length}/4 succeeded${reasons.length ? ` · refused: ${reasons.map((r) => r.slice(0, 48)).join(' | ')}` : ''}`)

      const after = await read(o.id)
      const captured = await prisma.payment.aggregate({ where: { orderId: o.id }, _sum: { amount: true } })
      const returned = await prisma.refund.aggregate({
        where: { payment: { orderId: o.id } }, _sum: { amount: true },
      })
      const held = (captured._sum.amount ?? 0) - (returned._sum.amount ?? 0)

      check(
        'the bill never holds more money than it is worth',
        after.paidTotal <= after.grandTotal + after.tipAmount,
        `paid=${after.paidTotal} billed=${after.grandTotal + after.tipAmount}`,
      )
      check(
        'paidTotal is exactly what came in less what went back',
        after.paidTotal === held,
        `paid=${after.paidTotal} captured=${captured._sum.amount} returned=${returned._sum.amount}`,
      )
      check('outstanding is never negative', outstandingOn(after) >= 0, `${outstandingOn(after)}`)
      check('the bill still totals something sane', after.grandTotal >= 0, `${after.grandTotal}`)

      const liveLines = await prisma.orderItem.count({
        where: { orderId: o.id, status: { not: 'CANCELLED' } },
      })
      check('at least one line survives — a bill is not voided to nothing this way',
        liveLines >= 1, `${liveLines}`)
    }

  } finally {
    await prisma.refund.deleteMany({ where: { payment: { restaurantId: restaurant.id } } })
    await prisma.payment.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
    await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.foodBranch.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.auditLog.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.restaurant.deleteMany({ where: { id: restaurant.id } })
    await prisma.$disconnect()
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
