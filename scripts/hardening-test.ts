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

  /*
   * production.md §1 — history cannot be silently overwritten.
   *
   * These are database triggers, not application checks, so the test has to go
   * around the application to mean anything: it writes with raw SQL, the way a
   * stray script or a psql session would. Before migration
   * 20260917093000_append_only_guards every one of these UPDATEs succeeded and
   * left no trace that anything had been different.
   */
  console.log('\n── 3. Append-only records refuse to be rewritten ──')
  {
    const refused = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run()
        check(name, false, 'the write was allowed')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        check(name, /append-only|immutable|is a fact/.test(message), `wrong error: ${message}`)
      }
    }

    const log = await prisma.auditLog.create({
      data: {
        restaurantId: restaurant.id, action: 'test.frozen', entity: 'Test',
        before: {}, after: { value: 'original' },
      },
    })
    await refused('an audit row cannot be edited', () =>
      prisma.$executeRaw`UPDATE audit_logs SET action = 'test.tampered' WHERE id = ${log.id}`)
    const stillThere = await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })
    check('…and it still says what it said', stillThere.action === 'test.frozen', stillThere.action)

    const item = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name: `Frozen ${stamp}`, unit: 'KG',
        quantity: 0, costPerUnit: 100_00, branchId: branch.id,
      },
    })
    const movement = await prisma.stockMovement.create({
      data: {
        restaurantId: restaurant.id, itemId: item.id, branchId: branch.id,
        type: 'PURCHASE', quantity: 10, unitCost: 100_00, balanceAfter: 10,
      },
    })
    await refused('a ledger quantity cannot be revised', () =>
      prisma.$executeRaw`UPDATE stock_movements SET quantity = 999 WHERE id = ${movement.id}`)
    await refused('a ledger cost cannot be revised', () =>
      prisma.$executeRaw`UPDATE stock_movements SET "unitCost" = 1 WHERE id = ${movement.id}`)

    /*
     * DELIBERATE exemption, pinned so nobody "tightens" it into a bug: goods
     * receipt, wastage and production all backfill batchId / referenceId onto
     * a movement immediately after creating it. Those are links, not ledger
     * facts, and blocking them would break receiving.
     */
    await prisma.stockMovement.update({
      where: { id: movement.id }, data: { referenceId: 'linked-after-the-fact' },
    })
    const linked = await prisma.stockMovement.findUniqueOrThrow({ where: { id: movement.id } })
    check('but a link column may still be backfilled',
      linked.referenceId === 'linked-after-the-fact' && linked.quantity === 10)

    await prisma.stockMovement.deleteMany({ where: { itemId: item.id } })
    await prisma.inventoryItem.delete({ where: { id: item.id } })
  }

  /*
   * production.md §1 names seven areas integrity checks must cover. Five were
   * already covered; COGS and bank reconciliation were not, and both fail in a
   * way every existing check stays green through — the quantities are right,
   * so the ledger replays perfectly, while the VALUE is wrong.
   */
  console.log('\n── 4. COGS and bank reconciliation are checked too ──')
  {
    const item = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name: `Costed ${stamp}`, unit: 'KG',
        quantity: 100, costPerUnit: 500_00, branchId: branch.id,
      },
    })

    // A sale that took stock out at no cost: the balance is right, cost of
    // sales is understated, and gross profit reads high for ever.
    const uncosted = await prisma.stockMovement.create({
      data: {
        restaurantId: restaurant.id, itemId: item.id, branchId: branch.id,
        type: 'SALE', quantity: -5, balanceAfter: 95, unitCost: 0,
      },
    })
    const cogsDirty = await runIntegrityChecks(restaurant.id)
    const cogsCheck = cogsDirty.checks.find((c) => c.key === 'cogs-uncosted-sale')
    check('stock sold at no cost is flagged',
      cogsCheck?.status === 'WARNING' && cogsCheck.count === 1,
      `${cogsCheck?.status} (${cogsCheck?.count})`)
    check('…and the movement is named', cogsCheck?.examples.includes(uncosted.id) ?? false)

    await prisma.stockMovement.deleteMany({ where: { id: uncosted.id } })
    const cogsClean = await runIntegrityChecks(restaurant.id)
    check('removing it clears the warning',
      cogsClean.checks.find((c) => c.key === 'cogs-uncosted-sale')?.status === 'OK')

    // The same receipt reconciled by two bank lines: the statement balances,
    // and the business believes it was paid twice.
    const statement = await prisma.bankStatement.create({
      data: {
        restaurantId: restaurant.id, fileName: 'march.csv',
        importHash: `hash-${stamp}`, lineCount: 2, uploadedByName: 'Test',
      },
    })
    await prisma.bankStatementLine.createMany({
      data: [
        {
          restaurantId: restaurant.id, statementId: statement.id, lineDate: new Date(),
          description: 'Card settlement', amount: 100_000, lineHash: `l1-${stamp}`,
          status: 'MATCHED', matchedType: 'PAYMENT', matchedId: `pay-${stamp}`,
        },
        {
          restaurantId: restaurant.id, statementId: statement.id, lineDate: new Date(),
          description: 'Card settlement', amount: 100_000, lineHash: `l2-${stamp}`,
          status: 'MATCHED', matchedType: 'PAYMENT', matchedId: `pay-${stamp}`,
        },
      ],
    })
    const bankDirty = await runIntegrityChecks(restaurant.id)
    const doubleMatch = bankDirty.checks.find((c) => c.key === 'bank-double-match')
    check('one receipt reconciled by two statement lines turns ERROR',
      doubleMatch?.status === 'ERROR' && doubleMatch.count === 1,
      `${doubleMatch?.status} (${doubleMatch?.count})`)

    /*
     * A line that contradicts itself about whether it was reconciled needs no
     * integrity check, and this proves why: the database refuses to store one.
     * `bank_statement_lines_match_shape` has enforced it since the accountant
     * control centre landed, so a checker entry for it could only ever report
     * OK — coverage in appearance only. The double-match above is the failure
     * that constraint cannot see, because each row is well-formed on its own.
     */
    let refusedShapeless = false
    try {
      await prisma.bankStatementLine.create({
        data: {
          restaurantId: restaurant.id, statementId: statement.id, lineDate: new Date(),
          description: 'Shapeless', amount: 5_000, lineHash: `l3-${stamp}`,
          status: 'MATCHED', matchedType: null, matchedId: null,
        },
      })
    } catch {
      refusedShapeless = true
    }
    check('the database itself refuses a MATCHED line with nothing matched', refusedShapeless)

    await prisma.bankStatement.delete({ where: { id: statement.id } })
    await prisma.inventoryItem.delete({ where: { id: item.id } })
    const bankClean = await runIntegrityChecks(restaurant.id)
    check('clearing the statement restores OK',
      bankClean.checks.find((c) => c.key === 'bank-double-match')?.status === 'OK')
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
