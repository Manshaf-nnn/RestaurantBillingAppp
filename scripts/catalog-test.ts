/**
 * Units and stock categories.
 *
 * Before this there was no way to manage either. `StockUnit` was a Prisma enum
 * copy-pasted into twelve source files, and `InventoryItem.category` was free
 * text — so "Dairy" and "dairy" were two silent buckets and no screen could
 * offer the list back.
 *
 * The design decision worth testing is what units are NOT. `StockUnit` is still
 * the column type everywhere, because `toBaseUnits` encodes facts (a kilo is a
 * thousand grams) that guard every ledger row. The table governs what a unit is
 * called and whether it is offered — never what it is worth. So the tests below
 * check that switching a unit off changes no stock, and that an item's own unit
 * survives being retired.
 *
 * The category rule is that two columns must never disagree: items carry a
 * `categoryId` AND the legacy `category` string that the count sheet, the
 * search filter and the reports all still read. Writing one without the other
 * would recreate exactly the mess this replaces.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/catalog-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  activeUnits,
  listStockCategories,
  listUnits,
  resolveCategory,
  saveStockCategory,
  setStockCategoryActive,
  setUnitActive,
  updateUnit,
} from '../src/features/catalog/service'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Cat ${stamp}`, slug: `cat-${stamp}`, status: 'ACTIVE', isActive: true },
  })

  console.log('\n── units seed themselves ──')

  const units = await listUnits(restaurant.id)
  check('a new restaurant gets all nine', units.length === 9, `${units.length}`)
  check('every one is on by default', units.every((u) => u.isActive))
  check(
    'and they are in a sensible order',
    units[0]?.code === 'KG' && units[1]?.code === 'GRAM',
    units.map((u) => u.code).join(','),
  )
  check(
    'each carries a name and a symbol',
    units.every((u) => u.name.length > 0 && u.symbol.length > 0),
  )

  // Idempotent: reading again must not create a second set.
  const again = await listUnits(restaurant.id)
  check('reading twice does not duplicate them', again.length === 9, `${again.length}`)

  console.log('\n── renaming and switching off ──')

  const dozen = units.find((u) => u.code === 'DOZEN')!
  await updateUnit({
    restaurantId: restaurant.id,
    unitId: dozen.id,
    name: 'Dozen (12)',
    symbol: 'dz',
    sortOrder: 5,
  })

  const renamed = (await listUnits(restaurant.id)).find((u) => u.code === 'DOZEN')!
  check('a unit can be renamed', renamed.name === 'Dozen (12)', renamed.name)
  check('and re-symbolled', renamed.symbol === 'dz', renamed.symbol)
  check(
    'and moved up the list',
    (await listUnits(restaurant.id))[0]?.code === 'DOZEN',
    'sort order was ignored',
  )

  const bottle = units.find((u) => u.code === 'BOTTLE')!
  await setUnitActive({ restaurantId: restaurant.id, unitId: bottle.id, isActive: false })

  const offered = await activeUnits(restaurant.id)
  check('a unit switched off leaves the dropdown', !offered.some((u) => u.code === 'BOTTLE'))
  check('while the rest stay', offered.length === 8, `${offered.length}`)

  const kept = await activeUnits(restaurant.id, ['BOTTLE'])
  check(
    'but comes back for an item that already uses it',
    kept.some((u) => u.code === 'BOTTLE'),
    'editing an old item would have silently changed how its stock is measured',
  )

  console.log('\n── switching one off never touches stock ──')

  const rice = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Rice',
      unit: 'KG',
      quantity: 40,
      costPerUnit: 25_000,
    },
  })

  const kg = units.find((u) => u.code === 'KG')!
  await refuses(
    'a unit in use cannot be switched off',
    () => setUnitActive({ restaurantId: restaurant.id, unitId: kg.id, isActive: false }),
    /measured in/i,
  )

  const untouched = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })
  check('and the item is unharmed', untouched.unit === 'KG' && untouched.quantity === 40)

  console.log('\n── categories ──')

  const meat = await saveStockCategory({
    restaurantId: restaurant.id,
    name: 'Meat',
    description: 'Chicken, beef, fish',
    sortOrder: 10,
  })
  check('a category can be created', Boolean(meat.id))

  await refuses(
    'the same name twice is refused',
    () =>
      saveStockCategory({
        restaurantId: restaurant.id,
        name: 'Meat',
        description: null,
        sortOrder: 0,
      }),
    /already exists/i,
  )

  /*
   * The whole reason this table exists. Free text let "Dairy" and "dairy"
   * become two buckets that no report could reconcile.
   */
  await refuses(
    'and neither is a different capitalisation of it',
    () =>
      saveStockCategory({
        restaurantId: restaurant.id,
        name: 'meat',
        description: null,
        sortOrder: 0,
      }),
    /already exists/i,
  )

  console.log('\n── the two columns must never disagree ──')

  const resolved = await resolveCategory({ restaurantId: restaurant.id, categoryName: 'Meat' })
  check('resolving by name finds the existing row', resolved.categoryId === meat.id)
  check('and returns the canonical spelling', resolved.category === 'Meat', `${resolved.category}`)

  const byWrongCase = await resolveCategory({ restaurantId: restaurant.id, categoryName: 'MEAT' })
  check(
    'a different capitalisation resolves to the same row',
    byWrongCase.categoryId === meat.id,
    'a second bucket was created',
  )

  const fresh = await resolveCategory({ restaurantId: restaurant.id, categoryName: 'Packaging' })
  check('an unknown name becomes a real category', Boolean(fresh.categoryId))
  check(
    'rather than another loose string',
    (await listStockCategories(restaurant.id)).some((c) => c.name === 'Packaging'),
  )

  const empty = await resolveCategory({ restaurantId: restaurant.id, categoryName: '' })
  check('and blank stays blank', empty.categoryId === null && empty.category === null)

  await prisma.inventoryItem.update({
    where: { id: rice.id },
    data: { categoryId: meat.id, category: 'Meat' },
  })

  console.log('\n── renaming keeps every item in step ──')

  await saveStockCategory({
    restaurantId: restaurant.id,
    id: meat.id,
    name: 'Meat & fish',
    description: null,
    sortOrder: 10,
  })

  const afterRename = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })
  check('the FK still points at it', afterRename.categoryId === meat.id)
  check(
    'and the legacy string was updated with it',
    afterRename.category === 'Meat & fish',
    `${afterRename.category} — the count sheet and reports read this column`,
  )

  console.log('\n── retiring never orphans an item ──')

  await setStockCategoryActive({ restaurantId: restaurant.id, id: meat.id, isActive: false })

  const offeredCategories = await listStockCategories(restaurant.id, { activeOnly: true })
  check(
    'a retired category leaves the picker',
    !offeredCategories.some((c) => c.id === meat.id),
  )

  const stillThere = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })
  check(
    'but the item keeps it',
    stillThere.categoryId === meat.id && stillThere.category === 'Meat & fish',
    'retiring a category detached an item — last year’s spend report would lose it',
  )

  const restored = await setStockCategoryActive({
    restaurantId: restaurant.id,
    id: meat.id,
    isActive: true,
  })
  check('and it can be brought back', restored.isActive === true)

  console.log('\n── another restaurant sees none of it ──')

  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const theirCategories = await listStockCategories(other.id)
  const theirUnits = await listUnits(other.id)
  check('their category list is empty', theirCategories.length === 0, `${theirCategories.length}`)
  check('their units are their own nine', theirUnits.length === 9, `${theirUnits.length}`)
  check(
    'and our rename did not reach them',
    theirUnits.find((u) => u.code === 'DOZEN')?.name === 'Dozen',
    'unit labels leaked across tenants',
  )

  for (const id of [restaurant.id, other.id]) {
    await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
    await prisma.inventoryCategory.deleteMany({ where: { restaurantId: id } })
    await prisma.unit.deleteMany({ where: { restaurantId: id } })
    await prisma.restaurant.delete({ where: { id } })
  }
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
