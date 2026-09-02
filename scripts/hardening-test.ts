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
