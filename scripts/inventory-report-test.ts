/**
 * The Inventory Reports screen agrees with the ledger it reads.
 *
 * Every figure on that page is derived, so each one is a chance to disagree
 * with the layers or the movements. What this pins:
 *
 *   · total value is the SUM OF THE LAYERS, not quantity × a blended rate —
 *     the rule `no-average-cost-valuation` guards statically and this one
 *     proves numerically, with two receipts at different prices;
 *   · the category split adds back to the total, and shares add to 1;
 *   · the trend's last day equals today's value, and its first day equals
 *     what was there before the window's movements — it is unwound from the
 *     ledger, so it has to tie at both ends;
 *   · opening + in − out = closing, per item;
 *   · the movement buckets add up to what actually moved, with transfers
 *     counted in their own bucket rather than as in and out;
 *   · a branch filter narrows value and movement to that branch only.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/inventory-report-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  bucketOf,
  getInventoryReport,
  listItemInventory,
  listMovementDetails,
} from '../src/features/reports/inventory-report'
import { postMovementStandalone } from '../src/features/inventory/ledger'

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

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.stockMovementLot.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `Inv rpt ${stamp}`, slug: `invrpt-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  restaurantId = restaurant.id
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })

  const item = (name: string, category: string, unit: 'KG' | 'PIECE', reorderLevel = 0) =>
    prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name, category, unit, quantity: 0,
        costPerUnit: 0, reorderLevel,
      },
    })
  const chicken = await item('Chicken Breast', 'Meat & Poultry', 'KG', 30)
  const cheese = await item('Cheese Slice', 'Dairy & Eggs', 'PIECE', 50)
  const basil = await item('Fresh Basil', 'Vegetables', 'KG', 5)

  const from = new Date(Date.now() - 7 * 86_400_000)
  const to = new Date(Date.now() + 60_000)
  const window = { restaurantId: restaurant.id, from, to }

  console.log('\n── 1. Value is the sum of the layers, at two different prices ──')
  {
    // 10 kg at 1,000 and 10 kg at 1,400 — a blended rate would say 12,000
    // for either half, and the layers say 10,000 and 14,000.
    await postMovementStandalone({
      restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE', quantity: 10,
      enteredUnit: 'KG', unitCost: 100_000, totalValue: 10 * 100_000,
      reason: 'first', branchId: main.id, batchNo: `A-${stamp}`,
    })
    await postMovementStandalone({
      restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE', quantity: 10,
      enteredUnit: 'KG', unitCost: 140_000, totalValue: 10 * 140_000,
      reason: 'second', branchId: main.id, batchNo: `B-${stamp}`,
    })

    const report = await getInventoryReport({ ...window, branchId: main.id })
    check('total value is 10×1,000 + 10×1,400', report.totalValue === 10 * 100_000 + 10 * 140_000, String(report.totalValue))

    const layers = await prisma.stockBatch.aggregate({
      where: { restaurantId: restaurant.id, branchId: main.id, remainingQty: { gt: 0 } },
      _sum: { remainingValue: true },
    })
    check('and equals the layers exactly', report.totalValue === (layers._sum.remainingValue ?? 0))

    /*
     * Where a blended rate actually diverges, and why the total alone cannot
     * show it: 10 at 1,000 plus 10 at 1,400 averages to exactly 1,200, so the
     * TOTAL agrees either way. The difference appears the moment part of it
     * is drawn — §6 sells 6 kg and the layers charge 1,000 for all six, where
     * an average would charge 1,200 — and the moment one branch is asked
     * about on its own, which is §8.
     */
    const drawn = await prisma.stockBatch.findMany({
      where: { restaurantId: restaurant.id, itemId: chicken.id },
      orderBy: { receivedAt: 'asc' },
      select: { receivedValue: true, receivedQty: true },
    })
    check('the two layers are kept apart, at their own prices', drawn.length === 2, `${drawn.length} layers`)
    check(
      'and neither was rewritten to the average',
      drawn[0]?.receivedValue === 10 * 100_000 && drawn[1]?.receivedValue === 10 * 140_000,
      drawn.map((l) => l.receivedValue).join(' / '),
    )
  }

  console.log('\n── 2. Categories add back to the total ──')
  {
    await postMovementStandalone({
      restaurantId: restaurant.id, itemId: cheese.id, type: 'PURCHASE', quantity: 100,
      enteredUnit: 'PIECE', unitCost: 11_500, totalValue: 100 * 11_500,
      reason: 'cheese', branchId: main.id, batchNo: `C-${stamp}`,
    })
    const report = await getInventoryReport({ ...window, branchId: main.id })
    const summed = report.byCategory.reduce((sum, row) => sum + row.value, 0)
    check('the category values sum to the total', summed === report.totalValue, `${summed} vs ${report.totalValue}`)
    const shares = report.byCategory.reduce((sum, row) => sum + row.share, 0)
    check('and the shares sum to 1', Math.abs(shares - 1) < 1e-9, String(shares))
    check('each item is counted in exactly one category', report.byCategory.reduce((n, r) => n + r.items, 0) === report.totalItems)
  }

  console.log('\n── 3. The trend ties to the ledger at both ends ──')
  {
    const report = await getInventoryReport({ ...window, branchId: main.id })
    const last = report.trend[report.trend.length - 1]
    check('the last day equals the value on hand now', last?.value === report.totalValue, `${last?.value} vs ${report.totalValue}`)
    check('the series covers every day of the window', report.trend.length >= 7, `${report.trend.length} days`)
    // Everything was bought inside the window, so it opened at nothing.
    check('the first day is the opening position, not today’s', report.trend[0].value === 0, String(report.trend[0].value))
    check('and it never goes negative', report.trend.every((row) => row.value >= 0))
  }

  console.log('\n── 4. Opening + in − out = closing, per item ──')
  {
    await postMovementStandalone({
      restaurantId: restaurant.id, itemId: chicken.id, type: 'SALE', quantity: 6,
      enteredUnit: 'KG', reason: 'sold', branchId: main.id,
    })
    const rows = await listItemInventory({ ...window, branchId: main.id })
    const line = rows.find((row) => row.itemId === chicken.id)!
    check('chicken closes at 14 kg', line.closing === 14, String(line.closing))
    check('with 20 in and 6 out', line.stockIn === 20 && line.stockOut === 6, `${line.stockIn}/${line.stockOut}`)
    check('and opens at nothing', line.opening === 0, String(line.opening))
    const consistent = rows.every((row) => Math.abs(row.opening + row.stockIn - row.stockOut - row.closing) < 1e-6)
    check('every row balances', consistent)
  }

  console.log('\n── 5. Movements land in the right bucket ──')
  {
    check('a purchase is Stock In', bucketOf('PURCHASE') === 'IN')
    check('a sale is Stock Out', bucketOf('SALE') === 'OUT')
    check('wastage is Stock Out, not an adjustment', bucketOf('WASTAGE') === 'OUT')
    check('a transfer out is a Transfer, not Stock Out', bucketOf('TRANSFER_OUT') === 'TRANSFER')
    check('an adjustment is an Adjustment', bucketOf('ADJUSTMENT_IN') === 'ADJUSTMENT')

    const report = await getInventoryReport({ ...window, branchId: main.id })
    const inBucket = report.movements.find((row) => row.bucket === 'IN')!
    const outBucket = report.movements.find((row) => row.bucket === 'OUT')!
    check('Stock In value is what the three receipts cost', inBucket.value === 10 * 100_000 + 10 * 140_000 + 100 * 11_500, String(inBucket.value))
    check('Stock In units count every receipt', inBucket.units === 120, String(inBucket.units))
    check('Stock Out has the sale', outBucket.units === 6, String(outBucket.units))
    check(
      'the movement list agrees with the summary',
      (await listMovementDetails({ ...window, branchId: main.id })).length === 4,
    )
  }

  console.log('\n── 6. Usage and the top-consumed list ──')
  {
    const report = await getInventoryReport({ ...window, branchId: main.id })
    // 6 kg drawn oldest-first: all from the 1,000 layer.
    check('usage value is what the sale actually drew', report.usageValue.value === 6 * 100_000, String(report.usageValue.value))
    check('the top consumed item is the one that was sold', report.topConsumed[0]?.itemId === chicken.id)
    check('with the quantity used', report.topConsumed[0]?.quantity === 6, String(report.topConsumed[0]?.quantity))
  }

  console.log('\n── 7. Low stock, and what counts as out ──')
  {
    const report = await getInventoryReport({ ...window, branchId: main.id })
    const names = report.lowStockItemsAll.map((row) => row.name)
    // Basil was never received, so it is out; chicken (14 of 30) is low;
    // cheese (100 of 50) is fine.
    check('basil is out of stock', report.lowStockItemsAll.some((r) => r.name === 'Fresh Basil' && r.outOfStock))
    check('chicken is low but not out', report.lowStockItemsAll.some((r) => r.name === 'Chicken Breast' && !r.outOfStock))
    check('cheese is neither', !names.includes('Cheese Slice'), names.join(', '))
    check('out of stock is counted once', report.outOfStock.value === 1, String(report.outOfStock.value))
    check('low stock is counted once', report.lowStock.value === 1, String(report.lowStock.value))
    check('and the out-of-stock rows sort first', report.lowStockItemsAll[0]?.outOfStock === true)
  }

  console.log('\n── 8. A branch filter actually narrows ──')
  {
    await postMovementStandalone({
      restaurantId: restaurant.id, itemId: cheese.id, type: 'PURCHASE', quantity: 40,
      enteredUnit: 'PIECE', unitCost: 12_000, totalValue: 40 * 12_000,
      reason: 'kandy', branchId: kandy.id, batchNo: `K-${stamp}`,
    })

    const atMain = await getInventoryReport({ ...window, branchId: main.id })
    const atKandy = await getInventoryReport({ ...window, branchId: kandy.id })
    const everywhere = await getInventoryReport({ ...window, branchId: null })

    check('Kandy holds only its own delivery', atKandy.totalValue === 40 * 12_000, String(atKandy.totalValue))
    check('Main is unchanged by it', atMain.totalValue === 10 * 100_000 + 10 * 140_000 + 100 * 11_500 - 6 * 100_000, String(atMain.totalValue))
    check('and the two add up to the whole', everywhere.totalValue === atMain.totalValue + atKandy.totalValue, `${everywhere.totalValue}`)

    const kandyMoves = await listMovementDetails({ ...window, branchId: kandy.id })
    check('Kandy sees one movement', kandyMoves.length === 1, `${kandyMoves.length}`)
    check('and it is the one that happened there', kandyMoves[0]?.itemName === 'Cheese Slice')
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
