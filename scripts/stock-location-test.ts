/**
 * Stock must land somewhere.
 *
 * Every entry point used to write `branchId: user.branchId ?? null`. No screen
 * in the app sets `User.branchId`, so for an owner that is always null, and
 * `applyLocationDelta` discards a movement with no branch — the restaurant-wide
 * total rose while no `InventoryStock` row was ever created.
 *
 * The visible effect was that a warehouse's "Stock here" panel stayed empty for
 * ever and the transfer builder, which reads `InventoryStock`, had nothing to
 * offer. Stock existed in the accounts and on no shelf, and there was no way to
 * bootstrap a location: the only two paths that carried a branch — transfers and
 * production — both require the location to already hold something.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/stock-location-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { resolveStockLocation } from '../src/features/branches/service'
import { setOpeningBalance } from '../src/features/inventory/operations'
import { getLocationDetail, getTransferBuilderData } from '../src/features/transfers/queries'

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
    data: { name: `Loc ${stamp}`, slug: `loc-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const warehouse = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Ampara warehouse', code: 'AMP', type: 'CENTRAL_WAREHOUSE' },
  })
  const sugar = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Sugar', unit: 'KG', quantity: 0, costPerUnit: 300 },
  })

  console.log('\nAn owner with no home branch still puts stock somewhere')

  // Exactly the owner's situation: no user.branchId, and no branch requested.
  const fallback = await resolveStockLocation({
    restaurantId: restaurant.id,
    requestedBranchId: null,
    userBranchId: null,
  })
  check('falls back to the main location rather than null', fallback === main.id, fallback)

  const chosen = await resolveStockLocation({
    restaurantId: restaurant.id,
    requestedBranchId: warehouse.id,
    userBranchId: null,
  })
  check('and honours an explicit choice', chosen === warehouse.id)

  console.log('\nWhy the fallback matters: a branch-less movement still vanishes')

  /*
   * This is the old behaviour, reproduced deliberately. postMovement still
   * accepts a null branch — a single-location restaurant that has never thought
   * about locations relies on it — so the guarantee lives in the resolver, and
   * this asserts what happens without it.
   */
  const ghost = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Ghost', unit: 'KG', quantity: 0, costPerUnit: 100 },
  })
  await setOpeningBalance({
    restaurantId: restaurant.id, itemId: ghost.id, quantity: 40, unitCost: 100, branchId: null,
  })
  const ghostItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ghost.id } })
  const ghostRows = await prisma.inventoryStock.count({ where: { itemId: ghost.id } })
  check('the restaurant total still rises', ghostItem.quantity === 40, `${ghostItem.quantity}`)
  check(
    'but it sits at NO location — exactly the bug the resolver prevents',
    ghostRows === 0,
    `${ghostRows} location rows`,
  )

  console.log('\n25 kg of sugar into the warehouse')

  await setOpeningBalance({
    restaurantId: restaurant.id,
    itemId: sugar.id,
    quantity: 25,
    unitCost: 300,
    branchId: warehouse.id,
  })

  const rows = await prisma.inventoryStock.findMany({
    where: { itemId: sugar.id, branchId: warehouse.id },
  })
  check('an InventoryStock row exists for that location', rows.length === 1, `${rows.length} rows`)
  check('holding 25', rows[0]?.available === 25, `${rows[0]?.available}`)

  const detail = await getLocationDetail({ restaurantId: restaurant.id, branchId: warehouse.id })
  const line = detail.stock.find((s) => s.itemId === sugar.id)
  check(
    '"Stock here" on the warehouse page shows it',
    Boolean(line) && line?.available === 25,
    line ? `available ${line.available}` : 'not listed',
  )
  check('with a value, not zero', (line?.value ?? 0) > 0, `${line?.value}`)

  console.log('\nAnd it can now actually be transferred')

  const builder = await getTransferBuilderData(restaurant.id)
  const fromWarehouse = builder.stockByBranch.find((b) => b.branchId === warehouse.id)
  check(
    'the transfer form offers it from the warehouse',
    Boolean(fromWarehouse?.items.some((i) => i.itemId === sugar.id)),
    `${fromWarehouse?.items.length ?? 0} items offered`,
  )

  console.log('\nEach location gets its own opening balance')

  // This used to be refused restaurant-wide, so a second location could never
  // be opened with an item the first already carried.
  await setOpeningBalance({
    restaurantId: restaurant.id,
    itemId: sugar.id,
    quantity: 10,
    unitCost: 300,
    branchId: main.id,
  })
  const atMain = await prisma.inventoryStock.findFirst({
    where: { itemId: sugar.id, branchId: main.id },
  })
  check('the main location can open the same item', atMain?.available === 10, `${atMain?.available}`)

  const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: sugar.id } })
  const perBranch = await prisma.inventoryStock.aggregate({
    where: { itemId: sugar.id },
    _sum: { available: true },
  })
  check(
    'and the locations still sum to the restaurant total',
    perBranch._sum.available === item.quantity,
    `locations ${perBranch._sum.available} vs total ${item.quantity}`,
  )

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
