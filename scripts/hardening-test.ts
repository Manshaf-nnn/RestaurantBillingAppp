/**
 * Audit, hardening, ops truth (AUDIT.md Slice 6).
 *
 *   • The §115–116 integrity checker actually catches broken arithmetic —
 *     tested by breaking a row on purpose and watching it turn ERROR, then
 *     fixing it and watching it turn OK. A checker that has never failed in
 *     front of you is a checker you know nothing about.
 *   • Rate-limit counters live in Postgres, shared across instances — the
 *     in-memory fallback counted per serverless instance, i.e. to one.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/hardening-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { runIntegrityChecks } from '../src/features/accounting/integrity'
import { incrementCounter } from '../src/server/cache/redis'

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

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Hard ${stamp}`, slug: `hard-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })

  console.log('\n── 1. The integrity checker catches what it claims to ──')
  {
    const clean = await runIntegrityChecks(restaurant.id)
    check('an empty restaurant reconciles', clean.status === 'OK', clean.status)

    // Break the books on purpose: an order whose subtotal its lines cannot
    // produce — the exact shape of the guest-edit bug the checker exists for.
    const broken = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `HARD-${stamp}`,
        customerName: 'X', customerPhone: '', subtotal: 999_999, grandTotal: 999_999,
        items: {
          create: [{ name: 'Ghost dish', unitPrice: 1000, quantity: 1, lineTotal: 1000 }],
        },
      },
    })
    const dirty = await runIntegrityChecks(restaurant.id)
    const lineCheck = dirty.checks.find((c) => c.key === 'order-line-sum')
    check('a subtotal its lines cannot produce turns ERROR',
      dirty.status === 'ERROR' && lineCheck?.status === 'ERROR' && lineCheck.count === 1,
      `${dirty.status} / ${lineCheck?.status} (${lineCheck?.count})`)
    check('…and names the offending order', lineCheck?.examples.includes(broken.id) ?? false)

    await prisma.order.update({ where: { id: broken.id }, data: { subtotal: 1000, grandTotal: 1000 } })
    const fixed = await runIntegrityChecks(restaurant.id)
    check('fixing the row turns it OK again', fixed.status === 'OK', fixed.status)

    // A loyalty balance with no ledger behind it.
    const customer = await prisma.customer.create({
      data: { restaurantId: restaurant.id, name: 'Y', phone: `071${stamp.slice(-6)}`, loyaltyPoints: 500 },
    })
    const drifted = await runIntegrityChecks(restaurant.id)
    const loyaltyCheck = drifted.checks.find((c) => c.key === 'loyalty-ledger')
    check('a balance the ledger cannot explain turns ERROR', loyaltyCheck?.status === 'ERROR')
    await prisma.loyaltyEntry.create({
      data: {
        restaurantId: restaurant.id, customerId: customer.id,
        points: 500, kind: 'ADJUSTED', note: 'opening',
      },
    })
    const explained = await runIntegrityChecks(restaurant.id)
    check('writing the explaining entry restores OK',
      explained.checks.find((c) => c.key === 'loyalty-ledger')?.status === 'OK')
  }

  console.log('\n── 1b. The accountant pattern checks catch what they claim to (acCal §7) ──')
  {
    const now = new Date()

    // Duplicate payments: same order, method, amount, 30 seconds apart.
    const dupOrder = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `DUP-${stamp}`,
        customerName: 'X', customerPhone: '', status: 'COMPLETED', paymentStatus: 'PAID',
        subtotal: 20_000, grandTotal: 20_000, paidTotal: 40_000, placedAt: now,
        payments: {
          create: [
            { restaurantId: restaurant.id, amount: 20_000, method: 'CARD', status: 'PAID', paidAt: now },
            { restaurantId: restaurant.id, amount: 20_000, method: 'CARD', status: 'PAID', paidAt: new Date(now.getTime() + 30_000) },
          ],
        },
      },
    })
    // Unusual discount: 60% off with no house pattern to lean on (<20 rows).
    const bigDiscount = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `DISC-${stamp}`,
        customerName: 'X', customerPhone: '', status: 'COMPLETED', paymentStatus: 'PAID',
        subtotal: 10_000, discountTotal: 6_000, manualDiscount: 6_000,
        grandTotal: 4_000, paidTotal: 4_000, placedAt: now,
      },
    })
    // Unusual refund: 100% of the bill went back.
    const refundOrder = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `REF-${stamp}`,
        customerName: 'X', customerPhone: '', status: 'COMPLETED', paymentStatus: 'REFUNDED',
        subtotal: 8_000, grandTotal: 8_000, paidTotal: 0, placedAt: now,
        payments: {
          create: [{ restaurantId: restaurant.id, amount: 8_000, method: 'CASH', status: 'REFUNDED', paidAt: now }],
        },
      },
    })
    const refundPayment = await prisma.payment.findFirstOrThrow({ where: { orderId: refundOrder.id } })
    await prisma.refund.create({
      data: {
        restaurantId: restaurant.id, orderId: refundOrder.id, paymentId: refundPayment.id,
        amount: 8_000, method: 'CASH', reason: 'hardening',
      },
    })
    // Backdated: a payment stamped three days before its order existed.
    const backdated = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `BACK-${stamp}`,
        customerName: 'X', customerPhone: '', status: 'COMPLETED', paymentStatus: 'PAID',
        subtotal: 5_000, grandTotal: 5_000, paidTotal: 5_000, placedAt: now,
        payments: {
          create: [{
            restaurantId: restaurant.id, amount: 5_000, method: 'CASH', status: 'PAID',
            paidAt: new Date(now.getTime() - 3 * 24 * 3600 * 1000),
          }],
        },
      },
    })

    const suspicious = await runIntegrityChecks(restaurant.id)
    const get = (key: string) => suspicious.checks.find((c) => c.key === key)
    check('a double-tap payment turns duplicate-payments WARNING',
      get('duplicate-payments')?.status === 'WARNING', get('duplicate-payments')?.status)
    check('a 60% discount with no house pattern turns unusual-discounts WARNING',
      get('unusual-discounts')?.status === 'WARNING' &&
        (get('unusual-discounts')?.count ?? 0) >= 1)
    check('a full refund turns unusual-refunds WARNING',
      get('unusual-refunds')?.status === 'WARNING')
    check('a payment three days before its order turns backdated WARNING',
      get('backdated-transactions')?.status === 'WARNING')
    check('pattern checks warn — they never block the books as ERROR',
      ['duplicate-payments', 'unusual-discounts', 'unusual-refunds', 'backdated-transactions']
        .every((key) => get(key)?.status !== 'ERROR'))

    // Clean up the deliberate mess so section 2 starts from OK books.
    await prisma.refund.deleteMany({ where: { orderId: refundOrder.id } })
    await prisma.order.deleteMany({
      where: { id: { in: [dupOrder.id, bigDiscount.id, refundOrder.id, backdated.id] } },
    })
  }

  console.log('\n── 2. Rate limits are shared, not per-instance ──')
  {
    const key = `rl:test:${stamp}`
    const first = await incrementCounter(key, 60)
    const second = await incrementCounter(key, 60)
    check('two calls in one window count to two', first.count === 1 && second.count === 2,
      `${first.count}, ${second.count}`)

    const persisted = await prisma.rateLimitCounter.findFirst({ where: { key } })
    check('…and the count lives in Postgres, where every instance sees it',
      persisted !== null && persisted.count === 2,
      `${persisted?.count}`)
    await prisma.rateLimitCounter.deleteMany({ where: { key } })
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
