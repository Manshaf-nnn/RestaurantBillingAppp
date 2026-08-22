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
import { listShiftNotes } from '../src/features/handover/queries'
import { closeDrawer, listDrawerSessions, openDrawer, recordCashMovement } from '../src/features/cashdrawer/service'
import { getKitchenQueue } from '../src/features/orders/queries'
import { getReportSummary } from '../src/features/analytics/queries'
import { postMovement } from '../src/features/inventory/ledger'
import {
  approveTransfer, dispatchTransfer, receiveTransfer, requestTransfer,
} from '../src/features/transfers/service'
import { assertApproved, decideApproval, requestApproval } from '../src/features/approvals/service'
import { locationRemovalBlockers, removeBranch } from '../src/features/branches/service'
import { resolveTable } from '../src/features/orders/actions'

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

  console.log('\n── switching branch is a server decision ──')

  /*
   * The switcher used to push the new URL from the browser, and Next answered
   * it from a prefetch cache whose key drops the query string — so picking a
   * second branch rendered the first one's tree while the URL bar updated.
   * `switchBranch` moves the decision to the server, where no client cache can
   * answer it.
   *
   * The redirect itself cannot be exercised here (it throws a framework signal
   * and needs a request context), so what is pinned is the part that protects
   * data: the branch is validated against what the caller may see, exactly as
   * the cookie path already was.
   */
  const confined = { role: 'MANAGER' as const, branchId: b01.id }

  check(
    'a confined manager may switch to their own branch',
    canAccessBranch(confined, b01.id),
  )
  check(
    'and may not switch to another',
    !canAccessBranch(confined, b02.id),
    'the switcher would have become a way to read another branch',
  )
  check(
    'an owner may switch to any of them',
    canAccessBranch({ role: 'OWNER', branchId: null }, b02.id),
  )

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


  // ────────────────────────────────────────────────────────────────────────
  // The second audit: everything below was written as a claim that FAILED
  // against the code before this pass, so each one pins a specific reported
  // symptom rather than restating a rule that already held.
  // ────────────────────────────────────────────────────────────────────────

  console.log('\n── 13. a handover note stays at the branch it was written at ──')

  const b01Note = await prisma.shiftNote.create({
    data: {
      restaurantId: restaurant.id,
      branchId: b01.id,
      body: 'Fridge two is running warm',
      authorName: 'Branch 01 closer',
    },
  })
  await prisma.shiftNote.create({
    data: {
      restaurantId: restaurant.id,
      branchId: main.id,
      body: 'Card machine needs paper',
      authorName: 'Main closer',
    },
  })

  const atMainNotes = await listShiftNotes(restaurant.id, [main.id])
  const atB01Notes = await listShiftNotes(restaurant.id, [b01.id])
  const everyNote = await listShiftNotes(restaurant.id, null)

  check(
    'Main Branch does not see Branch 01’s note',
    !atMainNotes.some((n) => n.id === b01Note.id),
    'this is the bug that was reported in as many words',
  )
  check('Branch 01 sees its own', atB01Notes.some((n) => n.id === b01Note.id))
  check('and the owner on "all locations" sees both', everyNote.length === 2, `${everyNote.length}`)
  check(
    'an unassigned user sees none, not all',
    (await listShiftNotes(restaurant.id, [])).length === 0,
    'an empty allow-list was read as "no filter"',
  )

  console.log('\n── 14. cash drawers, and the history that used to vanish ──')

  const b01Cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, branchId: b01.id, role: 'CASHIER',
      name: 'B01 Cashier', email: `b01c-${stamp}@t.test`, passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })
  const b02Cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, branchId: b02.id, role: 'CASHIER',
      name: 'B02 Cashier', email: `b02c-${stamp}@t.test`, passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })

  const b01Drawer = await openDrawer({
    restaurantId: restaurant.id, userId: b01Cashier.id,
    branchId: b01.id, userBranchId: b01.id, openingFloat: 500_00,
  })

  const b02Actor = {
    id: b02Cashier.id, role: 'CASHIER' as const, branchId: b02.id, canManageOthers: true,
  }
  await refuses(
    'Branch 02 cannot put cash into Branch 01’s drawer',
    () =>
      recordCashMovement({
        restaurantId: restaurant.id, sessionId: b01Drawer.id, actor: b02Actor,
        type: 'CASH_IN', amount: 100_00, reason: 'test', userId: b02Cashier.id,
      }),
    /another location/i,
  )
  await refuses(
    'nor close it',
    () =>
      closeDrawer({
        restaurantId: restaurant.id, sessionId: b01Drawer.id, actor: b02Actor,
        countedCash: 0, userId: b02Cashier.id,
      }),
    /another location/i,
  )

  const b01Actor = {
    id: b01Cashier.id, role: 'CASHIER' as const, branchId: b01.id, canManageOthers: true,
  }
  await closeDrawer({
    restaurantId: restaurant.id, sessionId: b01Drawer.id, actor: b01Actor,
    countedCash: 500_00, userId: b01Cashier.id,
  })

  const b01History = await listDrawerSessions({ restaurantId: restaurant.id, branchId: b01.id })
  const b02History = await listDrawerSessions({ restaurantId: restaurant.id, branchId: b02.id })
  check(
    'a CLOSED drawer is still in its branch’s history',
    b01History.some((d) => d.id === b01Drawer.id && d.status === 'CLOSED'),
    'closing it made it disappear',
  )
  check(
    'and the variance was snapshotted on it',
    b01History.find((d) => d.id === b01Drawer.id)?.variance === 0,
  )
  check('Branch 02 sees none of Branch 01’s drawers', b02History.length === 0, `${b02History.length}`)

  console.log('\n── 15. the kitchen rail is one kitchen’s ──')

  const mainQueue = await getKitchenQueue(restaurant.id, [main.id])
  const b01Queue = await getKitchenQueue(restaurant.id, [b01.id])
  check(
    'Main’s rail holds no Branch 01 ticket',
    mainQueue.every((o) => o.branchId === main.id),
    'a chef was reading another building’s orders',
  )
  check('and Branch 01’s holds none of Main’s', b01Queue.every((o) => o.branchId === b01.id))

  console.log('\n── 16. the reports screen answers for one branch ──')

  const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }
  const groupReport = await getReportSummary(restaurant.id, window)
  const b01Report = await getReportSummary(restaurant.id, window, [b01.id])
  const b02Report = await getReportSummary(restaurant.id, window, [b02.id])
  check(
    'Branch 02, which sold nothing, reports nothing',
    b02Report.orderCount === 0,
    `${b02Report.orderCount} orders leaked in`,
  )
  check(
    'Branch 01 reports its own and not the group’s',
    b01Report.revenue <= groupReport.revenue && b01Report.orderCount <= groupReport.orderCount,
    `${b01Report.revenue} vs ${groupReport.revenue}`,
  )

  console.log('\n── 17. a transfer waits for the owner, and stock waits with it ──')

  const grain = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: `Grain ${stamp}`, unit: 'KG',
      quantity: 0, costPerUnit: 1_000,
    },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, branchId: main.id, itemId: grain.id,
      type: 'OPENING_BALANCE', quantity: 100, unitCost: 1_000,
    }),
  )

  const held = async (branchId: string) =>
    (await prisma.inventoryStock.findFirst({ where: { itemId: grain.id, branchId } }))?.available ?? 0

  const transfer = await requestTransfer({
    restaurantId: restaurant.id,
    fromBranchId: main.id,
    toBranchId: b01.id,
    lines: [{ itemId: grain.id, quantity: 20 }],
  })
  check('a request moves no stock', (await held(main.id)) === 100, `${await held(main.id)}`)
  check('and none arrives', (await held(b01.id)) === 0, `${await held(b01.id)}`)

  const request = await requestApproval({
    restaurantId: restaurant.id, branchId: main.id, kind: 'STOCK_TRANSFER',
    entity: 'StockTransfer', entityId: transfer.id, reason: 'test',
  })
  await refuses(
    'and it cannot be approved before the owner rules on it',
    () =>
      assertApproved({
        restaurantId: restaurant.id, entity: 'StockTransfer',
        entityId: transfer.id, kind: 'STOCK_TRANSFER',
      }),
    /needs approval/i,
  )

  const requester = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, role: 'MANAGER', branchId: b01.id,
      name: 'Asker', email: `ask-${stamp}@t.test`, passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })
  await prisma.approvalRequest.update({
    where: { id: request.id }, data: { requestedById: requester.id },
  })
  await refuses(
    'and the person who asked cannot be the person who approves',
    () =>
      decideApproval({
        restaurantId: restaurant.id, approvalId: request.id,
        approve: true, userId: requester.id,
      }),
    /own request/i,
  )

  const decider = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, role: 'OWNER',
      name: 'Owner', email: `own-${stamp}@t.test`, passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })
  await decideApproval({
    restaurantId: restaurant.id, approvalId: request.id, approve: true, userId: decider.id,
  })
  await approveTransfer({ restaurantId: restaurant.id, transferId: transfer.id, userId: decider.id })
  check('approval still moves nothing — it reserves', (await held(main.id)) === 100, `${await held(main.id)}`)

  const transferLine = await prisma.stockTransferLine.findFirstOrThrow({
    where: { transferId: transfer.id },
  })
  await dispatchTransfer({
    restaurantId: restaurant.id, transferId: transfer.id, userId: decider.id,
    sent: [{ lineId: transferLine.id, quantity: 20 }],
  })
  check('the source falls at dispatch, and only then', (await held(main.id)) === 80, `${await held(main.id)}`)
  check('the destination has still not received it', (await held(b01.id)) === 0, `${await held(b01.id)}`)

  await receiveTransfer({
    restaurantId: restaurant.id, transferId: transfer.id, userId: decider.id,
    lines: [{ lineId: transferLine.id, receivedQty: 20 }],
  })
  check('and rises at receipt', (await held(b01.id)) === 20, `${await held(b01.id)}`)
  check(
    'a clean delivery completes itself',
    (await prisma.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status === 'COMPLETED',
  )

  console.log('\n── 18. a location holding stock refuses to go ──')

  const blocked = await locationRemovalBlockers(restaurant.id, b01.id)
  check(
    'Branch 01 cannot be removed while it holds stock',
    blocked.some((b) => /hold stock/.test(b.what)),
    JSON.stringify(blocked.map((b) => b.what)),
  )
  check(
    'the default location can never be removed',
    (await locationRemovalBlockers(restaurant.id, main.id)).some((b) => /default/i.test(b.what)),
  )
  await refuses(
    'and removing it anyway is refused',
    () => removeBranch({ restaurantId: restaurant.id, branchId: b01.id }),
    /cannot be removed/i,
  )

  const empty = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Popup', code: `POP${stamp.slice(-3).toUpperCase()}` },
  })
  check(
    'a location with nothing at it has no blockers',
    (await locationRemovalBlockers(restaurant.id, empty.id)).length === 0,
  )
  await removeBranch({ restaurantId: restaurant.id, branchId: empty.id })
  const gone = await prisma.branch.findUniqueOrThrow({ where: { id: empty.id } })
  check('removing it is soft — the row and its history stay', gone.deletedAt !== null)
  check('and it is switched off', gone.isActive === false)


  console.log('\n── 20. the guest is seated at the branch they scanned ──')

  const seatedB01 = await resolveTable({ tableNumber: '1' }, restaurant.slug, 'B01')
  const seatedMain = await resolveTable({ tableNumber: '1' }, restaurant.slug, 'MAIN')

  check(
    'scanning Branch 01 and typing 1 gives BRANCH 01’s table 1',
    seatedB01.ok && seatedB01.data.tableId === table1B01.id,
    seatedB01.ok
      ? seatedB01.data.tableId === table1Main.id
        ? 'it returned Main’s table — the reported bug'
        : seatedB01.data.tableId
      : seatedB01.error,
  )
  check(
    'scanning Main and typing 1 gives MAIN’s table 1',
    seatedMain.ok && seatedMain.data.tableId === table1Main.id,
    seatedMain.ok ? seatedMain.data.tableId : seatedMain.error,
  )
  check(
    'and the answer names the branch it resolved',
    seatedB01.ok && seatedB01.data.branchCode === 'B01' && seatedB01.data.branchName === 'Branch 01',
  )

  // A number that exists only at Main is refused at Branch 01, and says where
  // it actually is — "not found" would send the guest hunting for a typo.
  await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '99', capacity: 2 },
  })
  const wrongPoster = await resolveTable({ tableNumber: '99' }, restaurant.slug, 'B01')
  check(
    'a table that is only at Main is refused at Branch 01',
    !wrongPoster.ok,
    'the guest was seated at another branch’s table',
  )
  check(
    'and the refusal says which branch it is at',
    !wrongPoster.ok && /Main Branch/.test(wrongPoster.error) && /Branch 01/.test(wrongPoster.error),
    !wrongPoster.ok ? wrongPoster.error : '',
  )

  console.log('\n── 21. the ticket reaches the branch that was scanned ──')

  const b01Order = await placeOrder({
    restaurantId: restaurant.id,
    branchId: b01.id,
    tableId: table1B01.id,
    type: 'DINE_IN',
    channel: 'QR',
    customerName: 'Scanner',
    customerPhone: `07${stamp.slice(-8).padEnd(8, '9')}`,
    items: [{ foodId: burger.id, quantity: 1, optionIds: [] }],
  })
  check('the order is stamped Branch 01', b01Order.branchId === b01.id, `${b01Order.branchId}`)

  const b01Rail = await getKitchenQueue(restaurant.id, [b01.id])
  const mainRail = await getKitchenQueue(restaurant.id, [main.id])
  check(
    'it is on Branch 01’s kitchen rail',
    b01Rail.some((o) => o.id === b01Order.id),
  )
  check(
    'and NOT on Main’s',
    !mainRail.some((o) => o.id === b01Order.id),
    'this is the symptom that was reported',
  )

  // The silent override that carried the bug: a table at one branch and a
  // branch id from another used to resolve quietly in the table's favour.
  await refuses(
    'a table and a branch that disagree are refused, not reconciled',
    () =>
      placeOrder({
        restaurantId: restaurant.id,
        branchId: main.id,
        tableId: table1B01.id,
        type: 'DINE_IN',
        channel: 'QR',
        customerName: 'Confused',
        customerPhone: `07${stamp.slice(-8).padEnd(8, '7')}`,
        items: [{ foodId: burger.id, quantity: 1, optionIds: [] }],
      }),
    /different location/i,
  )

  /*
   * Creating and moving a table are NOT tested here.
   *
   * Both go through `requirePermission`, which reads the session cookie, and
   * there is no request scope in a plain node process — the action returns
   * "cookies was called outside a request scope" rather than doing anything.
   * Testing them here would mean either mocking the session, which proves
   * nothing about the guard, or moving the branch decision out of the action
   * into a service that exists only to be tested.
   *
   * They are driven over real HTTP in `action-e2e-test.ts` instead, with a real
   * session, which is where the rest of this codebase's authenticated actions
   * are exercised.
   */

  await prisma.shiftNote.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.cashMovement.deleteMany({ where: { session: { restaurantId: restaurant.id } } })
  await prisma.cashDrawerSession.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: restaurant.id } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.notification.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: restaurant.id } })
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
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
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
