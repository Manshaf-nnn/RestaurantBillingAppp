/**
 * Phase 2 functional tests — stock ledger, unit conversion, stock counts.
 * Creates its own items and removes them at the end.
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement, recomputeBalance, directionOf } from '../src/features/inventory/ledger'
import {
  receiveStock, recordWastage, setOpeningBalance, adjustStock, returnToSupplier,
} from '../src/features/inventory/operations'
import {
  openStockCount, recordCountLines, submitStockCount, approveStockCount,
} from '../src/features/inventory/stock-count'
import { toBaseUnits, fromBaseUnits, UnitConversionError } from '../src/features/inventory/units'
import { levelFor, getInventorySummary } from '../src/features/inventory/alerts'
import { ensureDefaultBranch } from '../src/features/branches/service'

let pass = 0, fail = 0
const madeItems: string[] = []
const madeCounts: string[] = []

function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}
async function throws(name: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${name} — expected rejection`) }
  catch (e) {
    const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${name} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${name} (${c ?? 'rejected'})`) }
  }
}

/*
 * What `transferStock` used to do, written out.
 *
 * That helper has been deleted: it moved stock between two InventoryItem rows
 * and named no branch on either leg, so `applyLocationDelta` skipped both and
 * no location's balance ever changed. The two postings below are the same two
 * postings it made, with the location it should always have carried — so these
 * assertions still test what they were written to test.
 *
 * The real inter-location transfer is `src/features/transfers/service.ts`, with
 * a request, an approval, a dispatch and a receipt. It is covered by
 * branch-isolation-test.
 */
async function moveBetweenItems(params: {
  restaurantId: string
  branchId: string
  fromItemId: string
  toItemId: string
  quantity: number
  userId: string
}) {
  // One reference on both legs, so the pair can be found together in the
  // ledger — the assertion below checks exactly that.
  const reference = `TRF-${Date.now().toString(36).toUpperCase()}`
  await prisma.$transaction(async (tx) => {
    await postMovement(tx, {
      restaurantId: params.restaurantId, branchId: params.branchId, itemId: params.fromItemId,
      type: 'TRANSFER_OUT', quantity: params.quantity, userId: params.userId,
      referenceType: 'Transfer', referenceId: reference,
    })
    await postMovement(tx, {
      restaurantId: params.restaurantId, branchId: params.branchId, itemId: params.toItemId,
      type: 'TRANSFER_IN', quantity: params.quantity, userId: params.userId,
      referenceType: 'Transfer', referenceId: reference,
    })
  })
}

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

  const stamp = Date.now().toString(36)
  const mk = async (name: string, unit: 'KG' | 'PIECE', extra: Record<string, unknown> = {}) => {
    const item = await prisma.inventoryItem.create({
      data: { restaurantId: shop.id, name: `${name}-${stamp}`, unit, reorderLevel: 10, ...extra },
    })
    madeItems.push(item.id)
    return item
  }

  console.log('\n── 1. Unit conversion ───────────────────────────────────')
  const kgItem = { name: 'Chicken', unit: 'KG' as const, purchaseUnit: 'BOX' as const, unitsPerPurchaseUnit: 10 }
  ok('500 g into a kg item = 0.5', toBaseUnits(500, 'GRAM', kgItem) === 0.5)
  ok('2 kg stays 2 kg', toBaseUnits(2, 'KG', kgItem) === 2)
  ok('1 box of 10 kg = 10', toBaseUnits(1, 'BOX', kgItem) === 10)
  ok('3 boxes = 30 kg', toBaseUnits(3, 'BOX', kgItem) === 30)
  ok('0.5 kg shown as 500 g', fromBaseUnits(0.5, 'GRAM', kgItem) === 500)
  ok('1 dozen = 12 pieces', toBaseUnits(1, 'DOZEN', { name: 'Egg', unit: 'PIECE' }) === 12)
  ok('1 litre = 1000 ml', toBaseUnits(1, 'LITRE', { name: 'Oil', unit: 'ML' }) === 1000)
  try {
    toBaseUnits(1, 'BOX', { name: 'Rice', unit: 'KG' })
    fail++; console.log('  ✗ a box with no declared size is refused')
  } catch (e) {
    ok('a box with no declared size is refused, not guessed', e instanceof UnitConversionError)
  }
  try {
    toBaseUnits(1, 'LITRE', { name: 'Rice', unit: 'KG' })
    fail++; console.log('  ✗ litres into kg refused')
  } catch (e) {
    ok('litres into a kg item is refused', e instanceof UnitConversionError)
  }

  console.log('\n── 2. The ledger example from the spec ──────────────────')
  const patty = await mk('Chicken Patty', 'PIECE')
  await setOpeningBalance({ restaurantId: shop.id, branchId: shopBranch, itemId: patty.id, quantity: 100, userId: user.id })
  await receiveStock({ restaurantId: shop.id, branchId: shopBranch, itemId: patty.id, quantity: 50, unitCost: 20000, userId: user.id })
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: shop.id, branchId: shopBranch, itemId: patty.id, type: 'SALE', quantity: 20, userId: user.id,
  }))
  await recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: patty.id, quantity: 3, reason: 'dropped', userId: user.id })

  const pattyB = await mk('Chicken Patty B', 'PIECE')
  await moveBetweenItems({ restaurantId: shop.id, branchId: shopBranch, fromItemId: patty.id, toItemId: pattyB.id, quantity: 10, userId: user.id })
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: shop.id, branchId: shopBranch, itemId: patty.id, type: 'TRANSFER_IN', quantity: 5, userId: user.id,
  }))
  await adjustStock({ restaurantId: shop.id, branchId: shopBranch, itemId: patty.id, quantity: 2, direction: 'OUT', reason: 'correction', userId: user.id })

  const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: patty.id } })
  // 100 + 50 - 20 - 3 - 10 + 5 - 2 = 120
  ok('balance matches the worked example (120)', after.quantity === 120, `got ${after.quantity}`)

  const check = await recomputeBalance(shop.id, patty.id)
  ok('cached balance equals the replayed ledger', check.matches, `cached ${check.cached} vs ledger ${check.ledger}`)

  const rows = await prisma.stockMovement.findMany({
    where: { itemId: patty.id }, orderBy: { createdAt: 'asc' },
  })
  ok('every change wrote a ledger row', rows.length === 7, `got ${rows.length}`)
  ok('every row carries a running balance', rows.every((r) => r.balanceAfter !== null))
  ok('the last row balance equals the item balance', rows[rows.length - 1].balanceAfter === 120)

  console.log('\n── 3. The spec test: 100 / 10 / 5 / 20 ──────────────────')
  const beef = await mk('Beef', 'KG')
  const beefB = await mk('Beef Branch2', 'KG')
  await receiveStock({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 100, unitCost: 150000, userId: user.id })
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, type: 'SALE', quantity: 10, userId: user.id,
  }))
  await recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 5, reason: 'spoiled', userId: user.id })
  await moveBetweenItems({ restaurantId: shop.id, branchId: shopBranch, fromItemId: beef.id, toItemId: beefB.id, quantity: 20, userId: user.id })

  const beefAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef.id } })
  const beefBAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beefB.id } })
  ok('source is 65 after 100 − 10 − 5 − 20', beefAfter.quantity === 65, `got ${beefAfter.quantity}`)
  ok('destination received the 20', beefBAfter.quantity === 20, `got ${beefBAfter.quantity}`)
  ok('transfer conserves stock (65 + 20 = 85)', beefAfter.quantity + beefBAfter.quantity === 85)

  const legs = await prisma.stockMovement.findMany({ where: { referenceType: 'Transfer', itemId: { in: [beef.id, beefB.id] } } })
  ok('both transfer legs share one reference', legs.length === 2 && legs[0].referenceId === legs[1].referenceId)

  console.log('\n── 4. Costing ───────────────────────────────────────────')
  const rice = await mk('Rice', 'KG')
  await receiveStock({ restaurantId: shop.id, branchId: shopBranch, itemId: rice.id, quantity: 10, unitCost: 10000, userId: user.id })
  await receiveStock({ restaurantId: shop.id, branchId: shopBranch, itemId: rice.id, quantity: 10, unitCost: 20000, userId: user.id })
  const riced = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })
  ok('weighted average of 10@100 and 10@200 is 150', riced.costPerUnit === 15000, `got ${riced.costPerUnit}`)
  ok('last purchase cost is recorded', riced.lastPurchaseCost === 20000)
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: shop.id, branchId: shopBranch, itemId: rice.id, type: 'SALE', quantity: 5, userId: user.id,
  }))
  const ricedAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })
  ok('a sale does not move the average cost', ricedAfter.costPerUnit === 15000)

  console.log('\n── 5. Guards ────────────────────────────────────────────')
  await throws('a negative quantity is refused', () => prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, type: 'SALE', quantity: -5, userId: user.id,
  })), 'STOCK_SIGNED_QUANTITY')
  await throws('a zero quantity is refused', () => prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, type: 'SALE', quantity: 0, userId: user.id,
  })), 'STOCK_BAD_QUANTITY')
  await throws('wastage with no reason is refused',
    () => recordWastage({ restaurantId: shop.id, branchId: shopBranch, itemId: beef.id, quantity: 1, reason: '', userId: user.id }),
    'WASTAGE_NO_REASON')
  await throws('a second opening balance is refused',
    () => setOpeningBalance({ restaurantId: shop.id, branchId: shopBranch, itemId: patty.id, quantity: 5, userId: user.id }),
    'OPENING_BALANCE_EXISTS')
  // 'transferring to the same item is refused' was here. It guarded a rule
  // inside `transferStock`, which no longer exists — the real transfer moves
  // ONE item between two locations, and refusing a pointless move is
  // `requestTransfer`'s job now.
  ok('SALE is outbound, PURCHASE inbound', directionOf('SALE') === -1 && directionOf('PURCHASE') === 1)

  console.log('\n── 6. Stock count needs approval ────────────────────────')
  const count = await openStockCount({ restaurantId: shop.id, branchId: shopBranch, userId: user.id })
  madeCounts.push(count.id)
  const beforeCount = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef.id } })).quantity
  await recordCountLines({
    restaurantId: shop.id, stockCountId: count.id,
    lines: [{ itemId: beef.id, countedQty: 62 }],   // system 65, physical 62
  })
  const midCount = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef.id } })).quantity
  ok('recording a count moves NO stock', midCount === beforeCount, `${beforeCount} -> ${midCount}`)

  const line = await prisma.stockCountLine.findFirstOrThrow({ where: { stockCountId: count.id } })
  ok('variance is computed (-3)', line.variance === -3, `got ${line.variance}`)

  await submitStockCount(shop.id, count.id)
  const submitted = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef.id } })).quantity
  ok('submitting still moves no stock', submitted === beforeCount)

  // `selfApprovalAllowed` because this fixture's user is the owner, who counted
  // it themselves. A storeman may not; `stock-count-branch-test` covers that.
  const approved = await approveStockCount({
    restaurantId: shop.id, stockCountId: count.id, userId: user.id, selfApprovalAllowed: true,
  })
  const afterApproval = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef.id } })).quantity
  ok('approval posts the variance (65 -> 62)', afterApproval === 62, `got ${afterApproval}`)
  ok('one adjustment was made', approved.adjusted === 1)

  const adj = await prisma.stockMovement.findFirstOrThrow({
    where: { stockCountId: count.id }, orderBy: { createdAt: 'desc' },
  })
  ok('the adjustment references its count', adj.referenceType === 'StockCount' && adj.referenceId === count.id)
  ok('the adjustment is ADJUSTMENT_OUT', adj.type === 'ADJUSTMENT_OUT')
  await throws('approving twice is refused',
    () => approveStockCount({
      restaurantId: shop.id, stockCountId: count.id, userId: user.id, selfApprovalAllowed: true,
    }),
    'COUNT_APPROVED')

  const recheck = await recomputeBalance(shop.id, beef.id)
  ok('ledger still reconciles after the count', recheck.matches)

  console.log('\n── 7. Alerts ────────────────────────────────────────────')
  ok('zero is out of stock', levelFor({ quantity: 0, reorderLevel: 5, minStock: 0, maxStock: null }) === 'OUT_OF_STOCK')
  ok('negative is out of stock, not low', levelFor({ quantity: -2, reorderLevel: 5, minStock: 0, maxStock: null }) === 'OUT_OF_STOCK')
  ok('at reorder level is low', levelFor({ quantity: 5, reorderLevel: 5, minStock: 0, maxStock: null }) === 'LOW_STOCK')
  ok('above par is overstock', levelFor({ quantity: 90, reorderLevel: 5, minStock: 0, maxStock: 80 }) === 'OVERSTOCK')
  ok('healthy stock has no alert', levelFor({ quantity: 40, reorderLevel: 5, minStock: 0, maxStock: 80 }) === null)
  const summary = await getInventorySummary({ restaurantId: shop.id })
  ok('inventory value is a positive number', summary.inventoryValue > 0)

  console.log('\n── 8. Tenant isolation ──────────────────────────────────')
  await throws('posting to another tenant’s item is refused', () => prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: other.id, branchId: otherBranch, itemId: beef.id, type: 'SALE', quantity: 1, userId: user.id,
  })))
  // Cross-tenant transfer refusal: the same protection is asserted two lines
  // above, since every leg of a transfer goes through `postMovement`.
  await throws('counting another tenant’s item is refused',
    () => recordCountLines({ restaurantId: other.id, stockCountId: count.id, lines: [{ itemId: beef.id, countedQty: 1 }] }))
  const leak = await prisma.inventoryItem.findFirst({ where: { id: beef.id, restaurantId: other.id } })
  ok('an item id from another tenant does not resolve', leak === null)

  console.log('\n── 9. Return to supplier ────────────────────────────────')
  const beforeReturn = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })).quantity
  await returnToSupplier({ restaurantId: shop.id, branchId: shopBranch, itemId: rice.id, quantity: 2, reason: 'damaged bag', userId: user.id })
  const afterReturn = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })).quantity
  ok('a supplier return removes stock', afterReturn === beforeReturn - 2, `${beforeReturn} -> ${afterReturn}`)

  // cleanup
  // Wastage records reference the item with onDelete: Restrict, and this suite
  // creates them now that recordWastage writes a full record.
  await prisma.wastageRecord.deleteMany({ where: { itemId: { in: madeItems } } })
  await prisma.inventoryStock.deleteMany({ where: { itemId: { in: madeItems } } })
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: madeItems } } })
  await prisma.stockCountLine.deleteMany({ where: { stockCountId: { in: madeCounts } } })
  await prisma.stockCount.deleteMany({ where: { id: { in: madeCounts } } })
  await prisma.inventoryItem.deleteMany({ where: { id: { in: madeItems } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nCRASHED:', e)
  // Wastage records reference the item with onDelete: Restrict, and this suite
  // creates them now that recordWastage writes a full record.
  await prisma.wastageRecord.deleteMany({ where: { itemId: { in: madeItems } } })
  await prisma.inventoryStock.deleteMany({ where: { itemId: { in: madeItems } } })
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: madeItems } } }).catch(() => {})
  await prisma.stockCountLine.deleteMany({ where: { stockCountId: { in: madeCounts } } }).catch(() => {})
  await prisma.stockCount.deleteMany({ where: { id: { in: madeCounts } } }).catch(() => {})
  await prisma.inventoryItem.deleteMany({ where: { id: { in: madeItems } } }).catch(() => {})
  await prisma.$disconnect()
  process.exit(1)
})
