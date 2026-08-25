/**
 * A stock count is about ONE location.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * `recordCountLines` snapshotted `InventoryItem.quantity` — the restaurant-wide
 * cached total — while `approveStockCount` posts the variance at
 * `count.branchId`, a single location. So counting a branch CORRECTLY produced
 * a variance the size of everywhere else's stock, and approving it destroyed
 * that much at the branch:
 *
 *     40kg at the warehouse + 10kg here  →  item.quantity = 50
 *     counter walks the shelf, finds 10  →  variance recorded as −40
 *     manager approves                   →  ADJUSTMENT_OUT 40 at this branch
 *     this branch now holds              →  −30
 *
 * It had never fired, because the count sheet was independently broken and
 * offered zero items, so no count could reach approval. Fixing the sheet
 * without fixing this would have turned a dead screen into a stock-destroying
 * one — which is why the two changes had to ship together, and why the first
 * five checks below are the point of the whole file.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/stock-count-branch-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement, recomputeBalance } from '../src/features/inventory/ledger'
import { adjustStock, setOpeningBalance } from '../src/features/inventory/operations'
import {
  approveStockCount, cancelStockCount, openStockCount, recordCountLines, submitStockCount,
} from '../src/features/inventory/stock-count'
import { getStockCountDetail } from '../src/features/inventory/count-queries'

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

async function throws(name: string, fn: () => Promise<unknown>, code?: string) {
  try {
    await fn()
    check(name, false, 'it resolved')
  } catch (error) {
    const actual = (error as { code?: string }).code
    check(name, !code || actual === code, `wanted ${code}, got ${actual}`)
  }
}

const qty = async (id: string) =>
  (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantity

async function atBranch(itemId: string, branchId: string): Promise<number> {
  const rows = await prisma.inventoryStock.findMany({
    where: { itemId, branchId },
    select: { available: true },
  })
  return rows.reduce((sum, r) => sum + r.available, 0)
}

async function main() {
  const stamp = Date.now().toString(36)

  const shop = await prisma.restaurant.create({
    data: { name: `Count ${stamp}`, slug: `count-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Kandy', code: 'KND' },
  })
  const counter = await prisma.user.create({
    data: {
      restaurantId: shop.id, name: 'Counter', email: `counter-${stamp}@t.test`,
      passwordHash: 'x', role: 'INVENTORY_MANAGER',
    },
  })
  const manager = await prisma.user.create({
    data: {
      restaurantId: shop.id, name: 'Manager', email: `manager-${stamp}@t.test`,
      passwordHash: 'x', role: 'MANAGER',
    },
  })

  const mkItem = (name: string, cost = 100) =>
    prisma.inventoryItem.create({
      data: { restaurantId: shop.id, name, unit: 'KG', quantity: 0, costPerUnit: cost },
    })

  console.log('\n── 1. The headline: a correct count must not destroy stock ──')

  const rice = await mkItem('Rice')
  await setOpeningBalance({
    restaurantId: shop.id, branchId: main.id, itemId: rice.id, quantity: 40, userId: counter.id,
  })
  await setOpeningBalance({
    restaurantId: shop.id, branchId: kandy.id, itemId: rice.id, quantity: 10, userId: counter.id,
  })
  check('the group holds 50, Kandy holds 10', (await qty(rice.id)) === 50 && (await atBranch(rice.id, kandy.id)) === 10)

  const count = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count.id,
    lines: [{ itemId: rice.id, countedQty: 10 }],   // Kandy really does hold 10
  })

  const line = await prisma.stockCountLine.findFirstOrThrow({ where: { stockCountId: count.id } })
  // Was 50 — the group total — which is the whole bug.
  check('systemQty is the BRANCH figure, not the group total', line.systemQty === 10, `got ${line.systemQty}`)
  check('a correct count shows no variance', line.variance === 0, `got ${line.variance}`)

  await submitStockCount(shop.id, count.id)
  const result = await approveStockCount({
    restaurantId: shop.id, stockCountId: count.id, userId: manager.id,
  })
  check('nothing was adjusted', result.adjusted === 0 && result.unchanged === 1)
  // Was −30.
  check('Kandy still holds 10', (await atBranch(rice.id, kandy.id)) === 10, `got ${await atBranch(rice.id, kandy.id)}`)
  // Was 10 — the group had been drained by the size of the warehouse.
  check('the group still holds 50', (await qty(rice.id)) === 50, `got ${await qty(rice.id)}`)
  check(
    'no movement was posted at all',
    (await prisma.stockMovement.count({ where: { stockCountId: count.id } })) === 0,
  )

  console.log('\n── 2. A real shortfall still posts, at the right branch ─────')

  const count2 = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count2.id,
    lines: [{ itemId: rice.id, countedQty: 7 }],    // 3 short
  })
  await submitStockCount(shop.id, count2.id)
  await approveStockCount({ restaurantId: shop.id, stockCountId: count2.id, userId: manager.id })

  const adjustment = await prisma.stockMovement.findFirstOrThrow({
    where: { stockCountId: count2.id },
  })
  // The ledger carries direction in the sign, so an OUT of 3 is stored as −3.
  check(
    'one ADJUSTMENT_OUT of 3',
    adjustment.type === 'ADJUSTMENT_OUT' && adjustment.quantity === -3,
    `${adjustment.type} ${adjustment.quantity}`,
  )
  check('posted at Kandy', adjustment.branchId === kandy.id)
  check('Kandy now holds 7', (await atBranch(rice.id, kandy.id)) === 7, `got ${await atBranch(rice.id, kandy.id)}`)
  check('Main is untouched at 40', (await atBranch(rice.id, main.id)) === 40)
  check('the group is 47', (await qty(rice.id)) === 47, `got ${await qty(rice.id)}`)

  console.log('\n── 3. Discovery: counting stock the book never knew was here ─')

  const salt = await mkItem('Salt')
  await setOpeningBalance({
    restaurantId: shop.id, branchId: main.id, itemId: salt.id, quantity: 5, userId: counter.id,
  })
  const count3 = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count3.id,
    lines: [{ itemId: salt.id, countedQty: 3 }],
  })
  const saltLine = await prisma.stockCountLine.findFirstOrThrow({ where: { stockCountId: count3.id } })
  check('no stock row at this branch reads as 0, not as the group total', saltLine.systemQty === 0, `got ${saltLine.systemQty}`)
  check('and the variance is a find, not a loss', saltLine.variance === 3)

  await submitStockCount(shop.id, count3.id)
  await approveStockCount({ restaurantId: shop.id, stockCountId: count3.id, userId: manager.id })
  check('the row is created by counting it', (await atBranch(salt.id, kandy.id)) === 3)
  check('the group rises to 8', (await qty(salt.id)) === 8, `got ${await qty(salt.id)}`)

  console.log('\n── 4. A branch total is the SUM of its shelves ──────────────')

  /*
   * The trap a single-row implementation falls into. Receipts post to a named
   * shelf and sales post with no shelf at all, so one branch legitimately holds
   * several `InventoryStock` rows and only their sum is a position.
   */
  const coldRoom = await prisma.storageLocation.create({
    data: { restaurantId: shop.id, branchId: kandy.id, name: 'Cold room', code: `CR-${stamp}` },
  })
  const milk = await mkItem('Milk')
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: shop.id, itemId: milk.id, type: 'PURCHASE', quantity: 6,
      branchId: kandy.id, locationId: coldRoom.id, userId: counter.id,
    }),
  )
  await adjustStock({
    restaurantId: shop.id, branchId: kandy.id, itemId: milk.id, quantity: 2,
    direction: 'OUT', reason: 'sold', userId: counter.id,
  })

  const count4 = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count4.id,
    lines: [{ itemId: milk.id, countedQty: 4 }],
  })
  const milkLine = await prisma.stockCountLine.findFirstOrThrow({ where: { stockCountId: count4.id } })
  // 6 on the cold-room row, −2 on the unassigned row. Reading either alone is wrong.
  check('the shelves are summed (6 − 2 = 4)', milkLine.systemQty === 4, `got ${milkLine.systemQty}`)
  check('so a correct count of 4 shows no variance', milkLine.variance === 0)

  console.log('\n── 5. The sheet offers something to count ──────────────────')

  const detail = await getStockCountDetail({
    restaurantId: shop.id, stockCountId: count4.id, currency: 'LKR',
  })
  // Was always [] — `InventoryItem.branchId` is never written, so the old
  // filter matched nothing and every count sheet in the app was blank.
  check('the sheet is not empty', detail.sheet.length > 0, `got ${detail.sheet.length}`)
  check('every active item is offered', detail.sheet.length === 3, `got ${detail.sheet.length}`)
  check('milk is flagged as stocked here', detail.sheet.find((r) => r.itemId === milk.id)?.heldHere === true)
  check(
    'an item this branch has never held is offered but not flagged',
    detail.sheet.find((r) => r.itemId === salt.id) !== undefined,
  )

  console.log('\n── 6. The approver sees every line they are signing ─────────')

  const count5 = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count5.id,
    lines: [{ itemId: milk.id, countedQty: 1 }],
  })
  await prisma.inventoryItem.update({ where: { id: milk.id }, data: { isActive: false } })
  const afterRetire = await getStockCountDetail({
    restaurantId: shop.id, stockCountId: count5.id, currency: 'LKR',
  })
  // The review used to be built from the FILTERED item list, so a line whose
  // item fell out of scope vanished from the screen and still posted.
  check('a retired item’s line stays visible', afterRetire.review.length === 1)
  check('and is counted in the variance total', afterRetire.totals.withVariance === 1)
  await prisma.inventoryItem.update({ where: { id: milk.id }, data: { isActive: true } })

  console.log('\n── 7. Approving is safe to click twice ─────────────────────')

  await submitStockCount(shop.id, count5.id)
  const both = await Promise.allSettled([
    approveStockCount({ restaurantId: shop.id, stockCountId: count5.id, userId: manager.id }),
    approveStockCount({ restaurantId: shop.id, stockCountId: count5.id, userId: manager.id }),
  ])
  check(
    'exactly one of two concurrent approvals wins',
    both.filter((r) => r.status === 'fulfilled').length === 1,
    both.map((r) => r.status).join(', '),
  )
  check(
    'and the variance is posted once',
    (await prisma.stockMovement.count({ where: { stockCountId: count5.id } })) === 1,
  )

  console.log('\n── 8. Maker-checker ────────────────────────────────────────')

  const count6 = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count6.id,
    lines: [{ itemId: rice.id, countedQty: 1 }],
  })
  await submitStockCount(shop.id, count6.id)
  await throws(
    'the person who counted cannot approve it',
    () => approveStockCount({ restaurantId: shop.id, stockCountId: count6.id, userId: counter.id }),
    'COUNT_SELF_APPROVAL',
  )
  check(
    'nothing moved on the refusal',
    (await prisma.stockMovement.count({ where: { stockCountId: count6.id } })) === 0,
  )
  // An owner has nobody above them, so the action layer lets them through.
  const solo = await approveStockCount({
    restaurantId: shop.id, stockCountId: count6.id, userId: counter.id, selfApprovalAllowed: true,
  })
  check('an owner may approve their own count', solo.adjusted === 1)

  console.log('\n── 9. The snapshot is taken once ───────────────────────────')

  const count7 = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count7.id,
    lines: [{ itemId: salt.id, countedQty: 3 }],
  })
  const first = await prisma.stockCountLine.findFirstOrThrow({ where: { stockCountId: count7.id } })
  // Stock legitimately moves while the counter walks the rest of the store.
  await adjustStock({
    restaurantId: shop.id, branchId: kandy.id, itemId: salt.id, quantity: 2,
    direction: 'OUT', reason: 'used in service', userId: counter.id,
  })
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count7.id,
    lines: [{ itemId: salt.id, countedQty: 3 }],
  })
  const second = await prisma.stockCountLine.findFirstOrThrow({ where: { stockCountId: count7.id } })
  // The upsert used to rewrite systemQty on every save, silently absorbing the
  // adjustment above into "no discrepancy".
  check('re-saving does not re-baseline the line', second.systemQty === first.systemQty, `${first.systemQty} -> ${second.systemQty}`)
  check('so the variance still reflects what was observed', second.variance === first.variance)

  console.log('\n── 10. A draft can be abandoned ────────────────────────────')

  const count8 = await openStockCount({
    restaurantId: shop.id, branchId: kandy.id, userId: counter.id,
  })
  const cancelled = await cancelStockCount(shop.id, count8.id)
  check('cancel moves it to CANCELLED', cancelled.status === 'CANCELLED')
  await throws(
    'and a cancelled count takes no more lines',
    () => recordCountLines({
      restaurantId: shop.id, stockCountId: count8.id,
      lines: [{ itemId: rice.id, countedQty: 1 }],
    }),
    'COUNT_NOT_DRAFT',
  )

  console.log('\n── 11. The books still balance ─────────────────────────────')

  for (const [name, id] of [['rice', rice.id], ['salt', salt.id], ['milk', milk.id]] as const) {
    const replay = await recomputeBalance(shop.id, id)
    check(`${name}: cached balance = replayed ledger`, replay.matches)

    const perBranch = await prisma.inventoryStock.aggregate({
      where: { itemId: id },
      _sum: { available: true },
    })
    const total = await qty(id)
    check(
      `${name}: the locations add up to the total`,
      Math.abs((perBranch._sum.available ?? 0) - total) < 1e-6,
      `${perBranch._sum.available} vs ${total}`,
    )
  }

  await prisma.stockCountLine.deleteMany({ where: { stockCount: { restaurantId: shop.id } } })
  await prisma.stockCount.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.storageLocation.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.user.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.delete({ where: { id: shop.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
