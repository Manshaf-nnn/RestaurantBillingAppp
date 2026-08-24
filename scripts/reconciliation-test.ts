/**
 * The reconciliation statement, and whether it can actually see a problem.
 *
 * A report that always says "balanced" is worse than no report, so the test that
 * matters is the one where the books are deliberately broken: a balance written
 * without a movement behind it — exactly what three code paths in this app used
 * to do — must show up as drift.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/reconciliation-test.ts
 */
import { customRange } from '../src/features/reports/range'
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { getReconciliationReport } from '../src/features/reports/reconciliation'

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
    data: { name: `Recon ${stamp}`, slug: `recon-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const item = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Flour', unit: 'KG', quantity: 0, costPerUnit: 200 },
  })

  const post = (type: 'OPENING_BALANCE' | 'PURCHASE' | 'SALE' | 'WASTAGE', quantity: number, unitCost?: number) =>
    prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type, quantity, unitCost, branchId: branch.id,
      }),
    )

  // 100 opening, 50 bought, 30 sold, 5 wasted → 115 should remain.
  await post('OPENING_BALANCE', 100, 200)
  await post('PURCHASE', 50, 200)
  await post('SALE', 30)
  await post('WASTAGE', 5)

  const range = customRange(new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000))

  console.log('\nThe ladder adds up')

  const report = await getReconciliationReport({ restaurantId: restaurant.id, range })
  const line = report.lines.find((l) => l.itemId === item.id)

  check('the item appears', Boolean(line))
  if (!line) process.exit(1)

  check('everything in is 150', line.totalIn === 150, `${line.totalIn}`)
  check('everything out is 35', line.totalOut === 35, `${line.totalOut}`)
  check('closing is 115', line.expected === 115, `${line.expected}`)
  check('the movement breakdown names each kind', line.movements.length === 4,
    line.movements.map((m) => m.label).join(', '))
  check('closing value is 115 × 200', line.valueAtCost === 23_000, `${line.valueAtCost}`)
  check('no drift, so the books balance', line.drift === 0 && report.balanced, `drift ${line.drift}`)

  console.log('\nAnd it catches a balance changed without a movement')

  // Exactly what saveInventoryItem and recordStockMovement used to do.
  await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantity: 999 } })

  const broken = await getReconciliationReport({ restaurantId: restaurant.id, range })
  const brokenLine = broken.lines.find((l) => l.itemId === item.id)
  check(
    'the drift is reported, not averaged away',
    brokenLine?.drift === 884,
    `drift ${brokenLine?.drift}, expected 884`,
  )
  check('and the report says the books do not balance', broken.balanced === false)
  check('with a count of the items affected', broken.totals.drifting === 1, `${broken.totals.drifting}`)

  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
