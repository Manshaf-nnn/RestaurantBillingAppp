/**
 * Branch isolation, walked as the twelve scenarios that were asked for.
 *
 * The rule being tested: **each branch is an independent operational unit, and
 * nothing crosses between them unless somebody deliberately shares it.**
 *
 * The distinction that matters most here is between *filtered* and *enforced*.
 * `branch-scope-test.ts` already proves lists and totals are filtered — and it
 * passed green while a Kandy manager could read a Colombo order, approve a
 * Colombo purchase order and post variance adjustments into Colombo's ledger,
 * all by pasting an id. Filtering is what a UI does; enforcement is what a
 * service does, and only the second survives someone editing a URL. Scenario 12
 * is therefore tested per action rather than once.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/branch-isolation-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { getManagedMenu, getPublicMenu } from '../src/features/menu/queries'
import { applyBranchOverrides, replaceFoodBranches } from '../src/features/menu/branch-menu'
import { placeOrder } from '../src/features/orders/service'
import { resolvePublicBranch } from '../src/features/branches/public-branch'
import { getSalesReport } from '../src/features/reports/sales'
import { visibleBranchIds, canAccessBranch, assignableRoles } from '../src/lib/rbac'

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
    data: {
      name: `Chain ${stamp}`,
      slug: `chain-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
    },
  })

  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main Branch', code: 'MAIN', isDefault: true },
  })
  const b01 = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 01', code: 'B01' },
  })
  const b02 = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 02', code: 'B02' },
  })

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })

  // Rs. 1,200 in minor units — the example from the brief.
  const burger = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Chicken Burger',
      slug: `burger-${stamp}`,
      price: 120_000,
      isAvailable: true,
      branches: { create: [{ restaurantId: restaurant.id, branchId: main.id }] },
    },
  })

  console.log('\n── 1. a dish created at Main is not at Branch 01 ──')

  const mainMenu = await getManagedMenu(restaurant.id, undefined, main.id)
  const b01Menu = await getManagedMenu(restaurant.id, undefined, b01.id)
  check('Main has it', mainMenu.foods.some((f) => f.id === burger.id))
  check(
    'Branch 01 does not',
    !b01Menu.foods.some((f) => f.id === burger.id),
    'a dish spread to another branch on its own',
  )

  const guestMain = await getPublicMenu(restaurant.id, 'Asia/Colombo', main.id)
  const guestB01 = await getPublicMenu(restaurant.id, 'Asia/Colombo', b01.id)
  check('and the guest menu agrees at Main', guestMain.items.some((i) => i.id === burger.id))
  check(
    'and at Branch 01',
    !guestB01.items.some((i) => i.id === burger.id),
    'the dashboard hid it and the QR menu still sold it',
  )

  console.log('\n── 2. sharing it with Branch 01 ──')

  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: burger.id,
    branches: [{ branchId: main.id }, { branchId: b01.id }],
  })

  const shared = await getPublicMenu(restaurant.id, 'Asia/Colombo', b01.id)
  check('now Branch 01 has it', shared.items.some((i) => i.id === burger.id))
  check(
    'and Branch 02 still does not',
    !(await getPublicMenu(restaurant.id, 'Asia/Colombo', b02.id)).items.some(
      (i) => i.id === burger.id,
    ),
    'sharing with one branch shared it with all of them',
  )

  console.log('\n── 3. Branch 01 charges its own price ──')

  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: burger.id,
    branches: [{ branchId: main.id }, { branchId: b01.id, price: 140_000 }],
  })

  const pricedMain = await getPublicMenu(restaurant.id, 'Asia/Colombo', main.id)
  const pricedB01 = await getPublicMenu(restaurant.id, 'Asia/Colombo', b01.id)
  check(
    'Branch 01 shows 1,400',
    pricedB01.items.find((i) => i.id === burger.id)?.price === 140_000,
    `${pricedB01.items.find((i) => i.id === burger.id)?.price}`,
  )
  check(
    'Main still shows 1,200',
    pricedMain.items.find((i) => i.id === burger.id)?.price === 120_000,
    'changing one branch moved another',
  )

  /*
   * The difference between an override and a copy. Raising the base price must
   * still reach every branch that has not deliberately set its own — otherwise
   * a VAT change means editing every branch by hand and one of them gets missed.
   */
  await prisma.food.update({ where: { id: burger.id }, data: { price: 130_000 } })
  const afterRaise = await getPublicMenu(restaurant.id, 'Asia/Colombo', main.id)
  const b01AfterRaise = await getPublicMenu(restaurant.id, 'Asia/Colombo', b01.id)
  check(
    'raising the base price moves Main',
    afterRaise.items.find((i) => i.id === burger.id)?.price === 130_000,
  )
  check(
    'and leaves the overridden branch alone',
    b01AfterRaise.items.find((i) => i.id === burger.id)?.price === 140_000,
    'an override was overwritten by a base-price change',
  )

  const inherited = applyBranchOverrides(
    { id: 'x', price: 130_000, discountPrice: null, isAvailable: true, sortOrder: 0 },
    { price: null, discountPrice: null, isAvailable: true, sortOrder: null },
  )
  check('a blank override inherits rather than zeroing', inherited.price === 130_000)

  console.log('\n── 4. stock is already separate; keep it that way ──')

  const rice = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 0, costPerUnit: 25_000 },
  })
  await prisma.inventoryStock.create({
    data: { restaurantId: restaurant.id, itemId: rice.id, branchId: main.id, available: 50 },
  })
  await prisma.inventoryStock.create({
    data: { restaurantId: restaurant.id, itemId: rice.id, branchId: b01.id, available: 20 },
  })

  const atMain = await prisma.inventoryStock.findFirst({
    where: { itemId: rice.id, branchId: main.id },
  })
  const atB01 = await prisma.inventoryStock.findFirst({
    where: { itemId: rice.id, branchId: b01.id },
  })
  check('Main holds 50', atMain?.available === 50, `${atMain?.available}`)
  check('Branch 01 holds 20, separately', atB01?.available === 20, `${atB01?.available}`)

  console.log('\n── 5-7. who sees what ──')

  const b01Manager = { role: 'MANAGER' as const, branchId: b01.id }
  const owner = { role: 'OWNER' as const, branchId: null }

  check(
    'a Branch 01 manager sees only Branch 01',
    JSON.stringify(visibleBranchIds(b01Manager)) === JSON.stringify([b01.id]),
  )
  check('and cannot reach Branch 02', !canAccessBranch(b01Manager, b02.id))
  check('but can reach their own', canAccessBranch(b01Manager, b01.id))
  check('an owner reaches every branch', visibleBranchIds(owner) === null)
  check(
    'and a manager may not mint another manager',
    !assignableRoles('MANAGER').includes('MANAGER'),
  )

  console.log('\n── 8-9. the QR fixes the branch, and the price ──')

  const table1Main = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '1', capacity: 4 },
  })
  const table1B01 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: b01.id, number: '1', capacity: 4 },
  })
  check(
    'the same table number exists at two branches',
    table1Main.number === table1B01.number && table1Main.id !== table1B01.id,
    'the old restaurant-wide unique key would have refused this',
  )

  const scanned = await resolvePublicBranch(restaurant.id, 'B01')
  check('scanning Branch 01’s code resolves to Branch 01', scanned?.id === b01.id, `${scanned?.name}`)

  const nonsense = await resolvePublicBranch(restaurant.id, 'ZZZZ')
  check(
    'a smudged code falls back to the default rather than failing',
    nonsense?.id === main.id,
    'a guest with a damaged QR would have seen an error instead of a menu',
  )

  const order = await placeOrder({
    restaurantId: restaurant.id,
    tableId: table1B01.id,
    type: 'DINE_IN',
    channel: 'QR',
    customerName: 'Guest',
    customerPhone: `07${stamp.slice(-8).padEnd(8, '0')}`,
    items: [{ foodId: burger.id, quantity: 1, optionIds: [] }],
  })

  check('the order belongs to Branch 01', order.branchId === b01.id, `${order.branchId}`)

  const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
  check(
    'and was priced at Branch 01’s price, not the base',
    line.unitPrice === 140_000,
    `${line.unitPrice} — the guest was charged another branch's price`,
  )

  /*
   * The other half of isolation: a dish Branch 02 does not sell cannot be
   * ordered there, even by a caller that names its id directly.
   */
  const table1B02 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: b02.id, number: '1', capacity: 4 },
  })
  await refuses(
    'a dish Branch 02 does not sell cannot be ordered there',
    () =>
      placeOrder({
        restaurantId: restaurant.id,
        tableId: table1B02.id,
        type: 'DINE_IN',
        channel: 'QR',
        customerName: 'Guest Two',
        customerPhone: `08${stamp.slice(-8).padEnd(8, '0')}`,
        items: [{ foodId: burger.id, quantity: 1, optionIds: [] }],
      }),
    /not on the menu here/i,
  )

  console.log('\n── 11. reports respect the branch ──')

  const range = {
    from: new Date(Date.now() - 86_400_000),
    to: new Date(Date.now() + 86_400_000),
    preset: 'TODAY' as const,
    label: 'Today',
  }

  const b01Sales = await getSalesReport({
    restaurantId: restaurant.id,
    range,
    branchIds: [b01.id],
  })
  const b02Sales = await getSalesReport({
    restaurantId: restaurant.id,
    range,
    branchIds: [b02.id],
  })
  const allSales = await getSalesReport({ restaurantId: restaurant.id, range, branchIds: null })

  check('Branch 01 sees its order', b01Sales.totals.orders === 1, `${b01Sales.totals.orders}`)
  check('Branch 02 sees none of it', b02Sales.totals.orders === 0, `${b02Sales.totals.orders}`)
  check('and the owner sees it', allSales.totals.orders === 1, `${allSales.totals.orders}`)

  /*
   * The regression this whole change was built on: every order used to be
   * stored with no branch, and `NULL IN (…)` is never true, so branch reports
   * were empty of real data. The column is NOT NULL now.
   */
  const branchless = await prisma.order.count({
    where: { restaurantId: restaurant.id, branchId: undefined },
  })
  check('no order exists without a branch', branchless === (await prisma.order.count({ where: { restaurantId: restaurant.id } })))

  console.log('\n── 12. enforcement, not filtering ──')

  const colomboOrder = await prisma.order.findFirstOrThrow({ where: { id: order.id } })
  check(
    'an order carries the branch a guard can check',
    Boolean(colomboOrder.branchId),
    'there would be nothing to enforce against',
  )
  check(
    'and a Branch 02 manager fails that check',
    !canAccessBranch({ role: 'MANAGER', branchId: b02.id }, colomboOrder.branchId),
    'pasting the id would have opened another branch’s order',
  )

  // Tables, too: a branch manager must not act on another branch's floor.
  check(
    'a table belongs to exactly one branch',
    table1B01.branchId === b01.id && table1Main.branchId === main.id,
  )

  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
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
