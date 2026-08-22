/** Phase 5: wastage, batches, expiry, FEFO, variance. */
import { prisma } from '../src/server/db/prisma'
import { recordWastage, reviewWastage, getWastageReport } from '../src/features/inventory/wastage'
import { postMovement } from '../src/features/inventory/ledger'
import { upsertBatch, allocateFefo, bucketFor, listExpiringStock, getExpirySummary } from '../src/features/inventory/batches'
import { getVarianceReport } from '../src/features/inventory/variance-report'
import { setOpeningBalance, adjustStock } from '../src/features/inventory/operations'
import { recomputeBalance } from '../src/features/inventory/ledger'
import { openStockCount, recordCountLines, submitStockCount, approveStockCount } from '../src/features/inventory/stock-count'
import { ensureDefaultBranch } from '../src/features/branches/service'

let pass = 0, fail = 0
const items: string[] = [], counts: string[] = []
function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }
async function throws(n: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${n} — expected rejection`) }
  catch (e) { const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${n} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${n} (${c ?? 'rejected'})`) } }
}
const qty = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantity
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000)

async function main() {
  const shop = await prisma.restaurant.findFirstOrThrow({ where: { slug: 'the-copper-spoon' } })
  const other = await prisma.restaurant.findFirstOrThrow({ where: { slug: 'kava' } })

  /*
   * Where the stock in this fixture lives.
   *
   * The ledger will not post a movement without a location — a movement that
   * names no place updates the restaurant's total and nobody's balance, which
   * is exactly the drift these tests exist to catch.
   */
  const shopBranch = (await ensureDefaultBranch(shop.id)).id
  const otherBranch = (await ensureDefaultBranch(other.id)).id
  const user = await prisma.user.findFirstOrThrow({ where: { restaurantId: shop.id, deletedAt: null } })
  const S = Date.now().toString(36)

  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const i = await prisma.inventoryItem.create({
      data: { restaurantId: shop.id, name: `${name}-${S}`, unit: 'KG', costPerUnit: 100_00, ...extra },
    })
    items.push(i.id); return i
  }

  console.log('\n── 1. Wastage ───────────────────────────────────────────')
  const beef = await mk('Beef')
  await setOpeningBalance({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 100, userId: user.id })

  const w1 = await recordWastage({
    restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 5, reason: 'SPOILED',
    notes: 'left out overnight', userId: user.id,
  })
  ok('wastage removes stock', await qty(beef.id) === 95, `got ${await qty(beef.id)}`)
  ok('cost value is snapshotted', w1.costValue === 5 * 100_00, `got ${w1.costValue}`)
  ok('starts as RECORDED', w1.status === 'RECORDED')

  const mv = await prisma.stockMovement.findFirstOrThrow({ where: { id: w1.movementId! } })
  ok('logged as WASTAGE, not SALE', mv.type === 'WASTAGE')
  ok('the movement links back to the record', mv.referenceType === 'Wastage' && mv.referenceId === w1.id)

  await throws('reason OTHER with no note is refused',
    () => recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 1, reason: 'OTHER', userId: user.id }),
    'WASTAGE_NO_NOTE')
  await throws('zero quantity is refused',
    () => recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 0, reason: 'BURNT', userId: user.id }),
    'WASTAGE_BAD_QTY')

  console.log('\n── 2. Review ────────────────────────────────────────────')
  const reviewed = await reviewWastage({ restaurantId: shop.id, wastageId: w1.id, approve: true, userId: user.id })
  ok('approval records who and when', reviewed.status === 'APPROVED' && reviewed.approvedById === user.id)
  ok('approval does not move stock again', await qty(beef.id) === 95)
  await throws('reviewing twice is refused',
    () => reviewWastage({ restaurantId: shop.id, wastageId: w1.id, approve: true, userId: user.id }),
    'WASTAGE_REVIEWED')

  const w2 = await recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 2, reason: 'DROPPED', userId: user.id })
  const rejected = await reviewWastage({ restaurantId: shop.id, wastageId: w2.id, approve: false, userId: user.id })
  ok('rejecting marks it disputed', rejected.status === 'REJECTED')
  ok('rejecting does NOT restore stock — the food is still gone', await qty(beef.id) === 93, `got ${await qty(beef.id)}`)

  console.log('\n── 3. Wastage report ────────────────────────────────────')
  await recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 3, reason: 'EXPIRED', userId: user.id })
  const report = await getWastageReport({ restaurantId: shop.id, period: 'DAY', includeEmployees: true })
  const beefLine = report.topItems.find((i) => i.itemId === beef.id)
  ok('report totals the day', report.totalRecords >= 3)
  ok('top items include the wasted beef', beefLine !== undefined)
  ok('quantity accumulates across records', beefLine?.quantity === 10, `got ${beefLine?.quantity}`)
  ok('grouped by reason', report.byReason.length >= 3, `${report.byReason.length} reasons`)
  ok('reason shares sum to about 100', Math.abs(report.byReason.reduce((s, r) => s + r.share, 0) - 100) < 1)
  ok('employee attribution appears when permitted', report.byEmployee.length >= 1)
  const noEmp = await getWastageReport({ restaurantId: shop.id, period: 'DAY' })
  ok('employee attribution is withheld by default', noEmp.byEmployee.length === 0)

  console.log('\n── 4. Batches and FEFO ──────────────────────────────────')
  const chicken = await mk('Chicken', { trackBatches: true, useFefo: true })
  await prisma.$transaction(async (tx) => {
    await upsertBatch(tx, { restaurantId: shop.id, branchId: shopBranch, itemId: chicken.id, batchNo: 'CHK-2026-0825', quantity: 20, unitCost: 100_00, expiryDate: day(6) })
    await upsertBatch(tx, { restaurantId: shop.id, branchId: shopBranch, itemId: chicken.id, batchNo: 'CHK-2026-0823', quantity: 20, unitCost: 100_00, expiryDate: day(2) })
    await upsertBatch(tx, { restaurantId: shop.id, branchId: shopBranch, itemId: chicken.id, batchNo: 'CHK-NO-DATE', quantity: 20, unitCost: 100_00 })

    // The batches hold 60 kg, so the item balance must too. upsertBatch records
    // a lot; it does not move stock — receiving does both. Without this the
    // fixture wasted 5 kg from a balance of zero, which only passed while the
    // ledger allowed negative stock unconditionally.
    await postMovement(tx, {
      restaurantId: shop.id, branchId: shopBranch, itemId: chicken.id, type: 'OPENING_BALANCE',
      quantity: 60, unitCost: 100_00, userId: user.id,
    })
  })
  const alloc = await allocateFefo(prisma, { restaurantId: shop.id, itemId: chicken.id, quantity: 30 })
  ok('FEFO takes the earliest expiry first', alloc.allocations[0].batchNo === 'CHK-2026-0823', alloc.allocations[0].batchNo)
  ok('then the next expiry', alloc.allocations[1].batchNo === 'CHK-2026-0825', alloc.allocations[1].batchNo)
  ok('splits across batches correctly', alloc.allocations[0].quantity === 20 && alloc.allocations[1].quantity === 10)
  ok('no shortfall when stock covers it', alloc.shortfall === 0)

  const big = await allocateFefo(prisma, { restaurantId: shop.id, itemId: chicken.id, quantity: 100 })
  ok('undated batches are drawn last', big.allocations[big.allocations.length - 1].batchNo === 'CHK-NO-DATE')
  ok('a shortfall is reported, not thrown', big.shortfall === 40, `got ${big.shortfall}`)

  const topUp = await prisma.$transaction((tx) =>
    upsertBatch(tx, { restaurantId: shop.id, branchId: shopBranch, itemId: chicken.id, batchNo: 'CHK-2026-0823', quantity: 5, unitCost: 110_00 }))
  ok('topping up a batch adds to it', topUp.remainingQty === 25, `got ${topUp.remainingQty}`)

  console.log('\n── 5. Expiry buckets ────────────────────────────────────')
  const now = new Date()
  ok('yesterday is EXPIRED', bucketFor(day(-1), now, 30) === 'EXPIRED')
  ok('today is TODAY', bucketFor(now, now, 30) === 'TODAY')
  ok('in 2 days is WITHIN_3', bucketFor(day(2), now, 30) === 'WITHIN_3')
  ok('in 5 days is WITHIN_7', bucketFor(day(5), now, 30) === 'WITHIN_7')
  ok('in 20 days is WITHIN_PERIOD', bucketFor(day(20), now, 30) === 'WITHIN_PERIOD')
  ok('in 90 days is OK', bucketFor(day(90), now, 30) === 'OK')
  ok('no expiry date is OK', bucketFor(null, now, 30) === 'OK')

  const expiring = await listExpiringStock({ restaurantId: shop.id, periodDays: 30 })
  const mine = expiring.filter((e) => e.itemId === chicken.id)
  ok('expiring batches are listed', mine.length === 2, `got ${mine.length}`)
  ok('value at risk is calculated', mine.every((m) => m.valueAtRisk > 0))
  ok('soonest expiry first', (mine[0].daysLeft ?? 0) <= (mine[1].daysLeft ?? 0))
  const summary = await getExpirySummary({ restaurantId: shop.id, periodDays: 30 })
  ok('summary buckets are populated', summary.WITHIN_3.count >= 1 || summary.WITHIN_7.count >= 1)

  console.log('\n── 6. Wastage draws from batches ────────────────────────')
  const before = (await prisma.stockBatch.findFirstOrThrow({ where: { itemId: chicken.id, batchNo: 'CHK-2026-0823' } })).remainingQty
  await recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: chicken.id, quantity: 5, reason: 'EXPIRED', userId: user.id })
  const after = (await prisma.stockBatch.findFirstOrThrow({ where: { itemId: chicken.id, batchNo: 'CHK-2026-0823' } })).remainingQty
  ok('wastage draws from the earliest-expiring batch', after === before - 5, `${before} -> ${after}`)

  console.log('\n── 7. Adjustments ───────────────────────────────────────')
  const before2 = await qty(beef.id)
  await adjustStock({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 4, direction: 'IN', reason: 'found in back store', userId: user.id })
  ok('ADJUSTMENT_IN adds stock', await qty(beef.id) === before2 + 4)
  await adjustStock({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 2, direction: 'OUT', reason: 'miscount', userId: user.id })
  ok('ADJUSTMENT_OUT removes stock', await qty(beef.id) === before2 + 2)
  await throws('an adjustment with no reason is refused',
    () => adjustStock({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 1, direction: 'IN', reason: '', userId: user.id }),
    'ADJUSTMENT_NO_REASON')

  console.log('\n── 8. Variance report ───────────────────────────────────')
  const rice = await mk('Rice')
  await setOpeningBalance({ restaurantId: shop.id, branchId: shopBranch, itemId: rice.id, quantity: 100, userId: user.id })
  const count = await openStockCount({ restaurantId: shop.id, branchId: shopBranch, userId: user.id })
  counts.push(count.id)
  await recordCountLines({ restaurantId: shop.id, stockCountId: count.id, lines: [{ itemId: rice.id, countedQty: 96 }] })
  await submitStockCount(shop.id, count.id)
  await approveStockCount({ restaurantId: shop.id, stockCountId: count.id, userId: user.id })

  const variance = await getVarianceReport({ restaurantId: shop.id, days: 7 })
  const riceLine = variance.lines.find((l) => l.itemId === rice.id)
  ok('expected 100', riceLine?.expected === 100, `got ${riceLine?.expected}`)
  ok('actual 96', riceLine?.actual === 96, `got ${riceLine?.actual}`)
  ok('variance -4', riceLine?.variance === -4, `got ${riceLine?.variance}`)
  ok('variance value is -400 (4 × 100)', riceLine?.varianceValue === -4 * 100_00, `got ${riceLine?.varianceValue}`)
  ok('the count reference is carried', Boolean(riceLine?.countReference))
  ok('a shortfall with no wastage is unexplained', riceLine?.likelyExplained === false)
  ok('loss value is counted', variance.totals.lossValue >= 4 * 100_00)
  ok('unexplained loss is counted', variance.totals.unexplainedValue >= 4 * 100_00)

  console.log('\n── 9. Ledger integrity ──────────────────────────────────')
  for (const [name, id] of [['beef', beef.id], ['rice', rice.id], ['chicken', chicken.id]] as const) {
    const r = await recomputeBalance(shop.id, id)
    ok(`${name}: cached balance = replayed ledger`, r.matches, `${r.cached} vs ${r.ledger}`)
  }

  console.log('\n── 10. Tenant isolation ─────────────────────────────────')
  await throws('wasting another tenant’s item is refused',
    () => recordWastage({ restaurantId: other.id, branchId: otherBranch, itemId: beef.id, quantity: 1, reason: 'BURNT', userId: user.id }))
  const otherReport = await getWastageReport({ restaurantId: other.id, period: 'MONTH' })
  ok('another tenant sees none of this wastage',
    !otherReport.topItems.some((i) => items.includes(i.itemId)))
  const otherVariance = await getVarianceReport({ restaurantId: other.id, days: 7 })
  ok('another tenant sees none of this variance',
    !otherVariance.lines.some((l) => items.includes(l.itemId)))

  // cleanup
  await prisma.wastageRecord.deleteMany({ where: { itemId: { in: items } } })
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: items } } })
  await prisma.stockBatch.deleteMany({ where: { itemId: { in: items } } })
  await prisma.stockCountLine.deleteMany({ where: { stockCountId: { in: counts } } })
  await prisma.stockCount.deleteMany({ where: { id: { in: counts } } })
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nCRASHED:', e)
  await prisma.wastageRecord.deleteMany({ where: { itemId: { in: items } } }).catch(() => {})
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: items } } }).catch(() => {})
  await prisma.stockBatch.deleteMany({ where: { itemId: { in: items } } }).catch(() => {})
  await prisma.stockCountLine.deleteMany({ where: { stockCountId: { in: counts } } }).catch(() => {})
  await prisma.stockCount.deleteMany({ where: { id: { in: counts } } }).catch(() => {})
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items } } }).catch(() => {})
  await prisma.$disconnect()
  process.exit(1)
})
