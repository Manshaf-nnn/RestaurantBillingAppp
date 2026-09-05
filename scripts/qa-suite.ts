/**
 * TableFlow QA — the scenario from the brief, run against the real services.
 * Creates its own tenants and removes them afterwards.
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement, recomputeBalance } from '../src/features/inventory/ledger'
import { setOpeningBalance, recordWastage, adjustStock } from '../src/features/inventory/operations'
import { getLocationBalance } from '../src/features/inventory/location-stock'
import { reconcileOrderDepletion } from '../src/features/inventory/depletion'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { receiveGoods, createPurchaseReturn } from '../src/features/purchasing/receiving'
import { ensureDefaultBranch } from '../src/features/branches/service'
import {
  requestTransfer, approveTransfer, dispatchTransfer, receiveTransfer, closeTransfer,
} from '../src/features/transfers/service'
import { produceItem } from '../src/features/production/service'

let pass = 0, fail = 0
const failures: Array<{ id: string; expected: string; actual: string; severity: string }> = []
const shops: string[] = []

function ok(id: string, name: string, cond: boolean, expected = '', actual = '', sev = 'HIGH') {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}  expected ${expected}, got ${actual}`); failures.push({ id, expected, actual, severity: sev }) }
}
async function throws(id: string, name: string, fn: () => Promise<unknown>, sev = 'CRITICAL') {
  try { await fn(); fail++; console.log(`  ✗ ${id} ${name} — was allowed`); failures.push({ id, expected: 'rejected', actual: 'allowed', severity: sev }) }
  catch { pass++; console.log(`  ✓ ${id} ${name}`) }
}

async function main() {
  const S = Date.now().toString(36)
  const shop = await prisma.restaurant.create({ data: { name: `ABC ${S}`, slug: `abc-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' } })
  const other = await prisma.restaurant.create({ data: { name: `XYZ ${S}`, slug: `xyz-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' } })

  /*
   * Where the stock in this fixture lives.
   *
   * The ledger will not post a movement without a location — a movement that
   * names no place updates the restaurant's total and nobody's balance, which
   * is exactly the drift these tests exist to catch.
   */
  const otherBranch = (await ensureDefaultBranch(other.id)).id
  shops.push(shop.id, other.id)
  const user = await prisma.user.findFirstOrThrow({ where: { deletedAt: null } })

  const loc = async (name: string, code: string, type: 'BRANCH' | 'CENTRAL_WAREHOUSE' | 'PRODUCTION_HOUSE', isDefault = false) =>
    prisma.branch.create({ data: { restaurantId: shop.id, name, code, type, isDefault } })

  const colombo = await loc('Colombo', 'COL', 'BRANCH', true)
  const kandy = await loc('Kandy', 'KAN', 'BRANCH')
  const warehouse = await loc('Central Warehouse', 'CW', 'CENTRAL_WAREHOUSE')
  const ph = await loc('ABC Production House', 'PH', 'PRODUCTION_HOUSE')

  const store = async (branchId: string, name: string, code: string) =>
    prisma.storageLocation.create({ data: { restaurantId: shop.id, branchId, name, code } })
  const colMain = await store(colombo.id, 'Main Store', `CM${S}`)
  const colCold = await store(colombo.id, 'Cold Room', `CC${S}`)

  const cat = await prisma.category.create({ data: { restaurantId: shop.id, name: 'Mains', slug: `m-${S}` } })
  const item = async (name: string, unit: 'PIECE' | 'KG' | 'LITRE', branchId: string, cost = 100_00) =>
    prisma.inventoryItem.create({ data: { restaurantId: shop.id, name: `${name}-${S}`, unit, branchId, costPerUnit: cost, reorderLevel: 5 } })

  const patty = await item('Chicken Patty', 'PIECE', colombo.id, 200_00)
  const bun = await item('Bun', 'PIECE', colombo.id, 50_00)
  const cheese = await item('Cheese', 'PIECE', colombo.id, 80_00)

  const avail = async (id: string, b: string) => (await getLocationBalance({ restaurantId: shop.id, itemId: id, branchId: b })).available
  const transit = async (id: string, b: string) => (await getLocationBalance({ restaurantId: shop.id, itemId: id, branchId: b })).inTransit
  const total = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantity

  console.log('\n══ TEST 0 — OPENING BALANCE ═══════════════════════════')
  for (const i of [patty, bun, cheese]) {
    await setOpeningBalance({ restaurantId: shop.id, itemId: i.id, quantity: 100, userId: user.id, branchId: colombo.id, unitCost: i.costPerUnit })
  }
  ok('T0.1', 'patty 100 at Colombo', await avail(patty.id, colombo.id) === 100, '100', String(await avail(patty.id, colombo.id)))
  ok('T0.2', 'opening balance wrote a ledger row',
    (await prisma.stockMovement.count({ where: { itemId: patty.id, type: 'OPENING_BALANCE' } })) === 1)
  const opening = await prisma.stockMovement.findFirstOrThrow({ where: { itemId: patty.id, type: 'OPENING_BALANCE' } })
  ok('T0.3', 'ledger records balanceAfter', opening.balanceAfter === 100, '100', String(opening.balanceAfter))
  ok('T0.4', 'ledger records the user', opening.userId === user.id)
  ok('T0.5', 'ledger records the branch', opening.branchId === colombo.id)

  console.log('\n══ TEST 1 — PURCHASE ══════════════════════════════════')
  const supplier = await prisma.supplier.create({ data: { restaurantId: shop.id, name: `ABC Foods ${S}` } })
  const po = await createPurchaseOrder({
    restaurantId: shop.id, supplierId: supplier.id, branchId: colombo.id, userId: user.id,
    lines: [{ itemId: patty.id, quantity: 50, unit: 'PIECE', unitCost: 200_00 }],
  })
  ok('T1.1', 'creating a PO does NOT change stock', await avail(patty.id, colombo.id) === 100, '100', String(await avail(patty.id, colombo.id)), 'CRITICAL')
  await setPurchaseStatus({ restaurantId: shop.id, purchaseId: po.id, status: 'APPROVED', userId: user.id })
  const poLine = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po.id } })
  await receiveGoods({ restaurantId: shop.id, purchaseId: po.id, userId: user.id, lines: [{ purchaseItemId: poLine.id, acceptedQty: 50 }] })
  ok('T1.2', 'receiving raises stock 100 → 150', await avail(patty.id, colombo.id) === 150, '150', String(await avail(patty.id, colombo.id)), 'CRITICAL')
  const purch = await prisma.stockMovement.findFirstOrThrow({ where: { itemId: patty.id, type: 'PURCHASE' } })
  ok('T1.3', 'purchase ledger row references the PO', purch.referenceType === 'Purchase' && purch.referenceId === po.id)
  ok('T1.4', 'balanceAfter is 150', purch.balanceAfter === 150, '150', String(purch.balanceAfter))

  console.log('\n══ TEST 2 — SALE WITH RECIPE ══════════════════════════')
  const burger = await prisma.food.create({ data: { restaurantId: shop.id, categoryId: cat.id, name: `Burger ${S}`, slug: `b-${S}`, price: 1_200_00 } })
  const recipe = await prisma.recipe.create({
    data: { restaurantId: shop.id, foodId: burger.id, version: 1, isActive: true, yieldQty: 1,
      ingredients: { create: [
        { inventoryItemId: patty.id, quantity: 1, unit: 'PIECE' },
        { inventoryItemId: bun.id, quantity: 1, unit: 'PIECE' },
        { inventoryItemId: cheese.id, quantity: 1, unit: 'PIECE' },
      ] } },
  })
  const order = await prisma.order.create({
    data: { restaurantId: shop.id, branchId: colombo.id, orderNumber: `QA-${S}-1`, type: 'DINE_IN',
      status: 'PENDING', paymentStatus: 'UNPAID', customerName: 'QA', customerPhone: '07',
      subtotal: 3_600_00, grandTotal: 3_600_00,
      items: { create: [{ foodId: burger.id, name: burger.name, unitPrice: 1_200_00, quantity: 3, lineTotal: 3_600_00, recipeId: recipe.id }] } },
  })
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id }))
  ok('T2.1', 'patty 150 → 147', await avail(patty.id, colombo.id) === 147, '147', String(await avail(patty.id, colombo.id)), 'CRITICAL')
  ok('T2.2', 'bun 100 → 97', await avail(bun.id, colombo.id) === 97, '97', String(await avail(bun.id, colombo.id)), 'CRITICAL')
  ok('T2.3', 'cheese 100 → 97', await avail(cheese.id, colombo.id) === 97, '97', String(await avail(cheese.id, colombo.id)), 'CRITICAL')
  ok('T2.4', 'three SALE ledger rows', (await prisma.stockMovement.count({ where: { orderId: order.id, type: 'SALE' } })) === 3)

  console.log('\n══ TEST 3 — SALE CANCELLATION (1 of 3) ════════════════')
  await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { quantity: 2 } })
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id }))
  ok('T3.1', 'patty 147 → 148', await avail(patty.id, colombo.id) === 148, '148', String(await avail(patty.id, colombo.id)), 'CRITICAL')
  ok('T3.2', 'bun 97 → 98', await avail(bun.id, colombo.id) === 98, '98', String(await avail(bun.id, colombo.id)))
  ok('T3.3', 'cheese 97 → 98', await avail(cheese.id, colombo.id) === 98, '98', String(await avail(cheese.id, colombo.id)))
  ok('T3.4', 'the original SALE rows survive', (await prisma.stockMovement.count({ where: { orderId: order.id, type: 'SALE' } })) === 3, '3 kept', 'deleted', 'CRITICAL')
  ok('T3.5', 'reversal recorded as SALE_REVERSAL', (await prisma.stockMovement.count({ where: { orderId: order.id, type: 'SALE_REVERSAL' } })) === 3)

  console.log('\n══ TEST 4 — WASTAGE ═══════════════════════════════════')
  await recordWastage({ restaurantId: shop.id, itemId: patty.id, quantity: 2, reason: 'SPOILED', userId: user.id, branchId: colombo.id })
  ok('T4.1', 'patty 148 → 146', await avail(patty.id, colombo.id) === 146, '146', String(await avail(patty.id, colombo.id)))
  ok('T4.2', 'wastage record exists with a reason',
    (await prisma.wastageRecord.count({ where: { itemId: patty.id, reason: 'SPOILED' } })) === 1)
  ok('T4.3', 'wastage ledger row is WASTAGE, not SALE',
    (await prisma.stockMovement.count({ where: { itemId: patty.id, type: 'WASTAGE' } })) === 1, '', '', 'CRITICAL')

  console.log('\n══ TEST 5 — PRODUCTION ════════════════════════════════')
  const meat = await item('Chicken meat', 'KG', ph.id, 1_500_00)
  const season = await item('Seasoning', 'KG', ph.id, 800_00)
  const oil = await item('Oil', 'LITRE', ph.id, 600_00)
  const phPatty = await item('PH Patty', 'PIECE', ph.id, 0)
  // A prepared item, as the migration flags anything production has made.
  await prisma.inventoryItem.update({ where: { id: phPatty.id }, data: { isPrepared: true } })
  for (const [i, q] of [[meat, 20], [season, 2], [oil, 1]] as const) {
    await setOpeningBalance({ restaurantId: shop.id, itemId: i.id, quantity: q, userId: user.id, branchId: ph.id, unitCost: i.costPerUnit })
  }
  // One run makes 50 patties; the job below asks for 50 of them, not "1 batch".
  /*
   * DELIBERATE behaviour change 2026-09-05 (redesignkitchenjob.md): no recipe,
   * no planning stage. The kitchen names what it made and what it used, in one
   * step, and the ledger effects are the same as they always were.
   */
  const makePatties = (plannedQty: number, requestKey: string) => produceItem({
    restaurantId: shop.id, branchId: ph.id, userId: user.id, clientRequestId: requestKey,
    output: { itemId: phPatty.id, name: phPatty.name, quantity: plannedQty, unit: 'PIECE' },
    ingredients: [
      { itemId: meat.id, quantity: 10 * (plannedQty / 50), unit: 'KG' },
      { itemId: season.id, quantity: 1 * (plannedQty / 50), unit: 'KG' },
      { itemId: oil.id, quantity: 0.5 * (plannedQty / 50), unit: 'LITRE' },
    ],
  })
  ok('T5.1', 'the output is a prepared item', (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: phPatty.id } })).isPrepared, 'true', '', 'CRITICAL')
  const done = await makePatties(50, `qa-${S}-patties`)
  ok('T5.2', 'meat 20 → 10 kg', await avail(meat.id, ph.id) === 10, '10', String(await avail(meat.id, ph.id)), 'CRITICAL')
  ok('T5.3', 'seasoning 2 → 1 kg', await avail(season.id, ph.id) === 1, '1', String(await avail(season.id, ph.id)))
  ok('T5.4', 'oil 1 → 0.5 L', await avail(oil.id, ph.id) === 0.5, '0.5', String(await avail(oil.id, ph.id)))
  ok('T5.5', '50 patties produced', await avail(phPatty.id, ph.id) === 50, '50', String(await avail(phPatty.id, ph.id)), 'CRITICAL')
  ok('T5.6', 'PRODUCTION_CONSUMPTION rows for each raw material',
    (await prisma.stockMovement.count({ where: { referenceId: done.orderId, type: 'PRODUCTION_CONSUMPTION' } })) === 3)
  ok('T5.7', 'one PRODUCTION_OUTPUT row',
    (await prisma.stockMovement.count({ where: { referenceId: done.orderId, type: 'PRODUCTION_OUTPUT' } })) === 1)
  ok('T5.8', 'production cost computed', done.totalValue > 0 && done.unitCost > 0)

  console.log('\n══ TEST 6 — PRODUCTION → BRANCH ═══════════════════════')
  const t1 = await requestTransfer({ restaurantId: shop.id, fromBranchId: ph.id, toBranchId: colombo.id, lines: [{ itemId: phPatty.id, quantity: 20 }], userId: user.id })
  await approveTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id })
  ok('T6.1', 'approval moves no stock', await avail(phPatty.id, ph.id) === 50, '50', String(await avail(phPatty.id, ph.id)), 'CRITICAL')
  await dispatchTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id })
  ok('T6.2', 'source 50 → 30 on dispatch', await avail(phPatty.id, ph.id) === 30, '30', String(await avail(phPatty.id, ph.id)), 'CRITICAL')
  ok('T6.3', 'destination in-transit 20', await transit(phPatty.id, colombo.id) === 20, '20', String(await transit(phPatty.id, colombo.id)), 'CRITICAL')
  ok('T6.4', 'destination available still 0', await avail(phPatty.id, colombo.id) === 0, '0', String(await avail(phPatty.id, colombo.id)), 'CRITICAL')
  const l1 = await prisma.stockTransferLine.findFirstOrThrow({ where: { transferId: t1.id } })
  await receiveTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id, lines: [{ lineId: l1.id, receivedQty: 20 }] })
  ok('T6.5', 'destination available 20 after receipt', await avail(phPatty.id, colombo.id) === 20, '20', String(await avail(phPatty.id, colombo.id)), 'CRITICAL')
  ok('T6.6', 'in-transit cleared', await transit(phPatty.id, colombo.id) === 0, '0', String(await transit(phPatty.id, colombo.id)))

  console.log('\n══ TEST 7 — STORAGE-LEVEL STOCK ═══════════════════════')
  const stockRow = await prisma.inventoryStock.findFirst({ where: { itemId: patty.id, branchId: colombo.id } })
  ok('T7.1', 'stock rows carry a storage location', stockRow?.storageLocationId !== undefined,
    'storageLocationId present', 'field missing', 'MEDIUM')
  const perStorage = await prisma.inventoryStock.count({ where: { itemId: patty.id, branchId: colombo.id } })
  ok('T7.2', 'stock is keyed per (item, branch) — NOT per storage location', perStorage === 1,
    'documented limitation', String(perStorage), 'MEDIUM')

  console.log('\n══ TEST 8 — BRANCH TRANSFER + VARIANCE ════════════════')
  const t2 = await requestTransfer({ restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: kandy.id, lines: [{ itemId: patty.id, quantity: 30 }], userId: user.id })
  await approveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id })
  await dispatchTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id })
  const before = await avail(patty.id, colombo.id)
  const l2 = await prisma.stockTransferLine.findFirstOrThrow({ where: { transferId: t2.id } })
  await throws('T8.1', 'a shortfall with no reason is refused',
    () => receiveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id, lines: [{ lineId: l2.id, receivedQty: 28 }] }), 'HIGH')
  await receiveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id, lines: [{ lineId: l2.id, receivedQty: 28, varianceReason: 'DAMAGED_IN_TRANSIT' }] })
  ok('T8.2', 'Kandy receives 28', await avail(patty.id, kandy.id) === 28, '28', String(await avail(patty.id, kandy.id)), 'CRITICAL')
  const line2 = await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: l2.id } })
  ok('T8.3', 'sent 30 preserved', line2.sentQty === 30, '30', String(line2.sentQty), 'CRITICAL')
  ok('T8.4', 'variance is -2', line2.variance === -2, '-2', String(line2.variance), 'CRITICAL')
  ok('T8.5', 'source stayed reduced by the full 30', before === await avail(patty.id, colombo.id))

  console.log('\n══ TEST 9 — REJECT / CANCEL ═══════════════════════════')
  const t3 = await requestTransfer({ restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: kandy.id, lines: [{ itemId: bun.id, quantity: 5 }], userId: user.id })
  const bunBefore = await avail(bun.id, colombo.id)
  await closeTransfer({ restaurantId: shop.id, transferId: t3.id, status: 'REJECTED', reason: 'not needed', userId: user.id })
  ok('T9.1', 'rejecting moves no stock', await avail(bun.id, colombo.id) === bunBefore, String(bunBefore), String(await avail(bun.id, colombo.id)), 'CRITICAL')
  const t4 = await requestTransfer({ restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: kandy.id, lines: [{ itemId: bun.id, quantity: 5 }], userId: user.id })
  await approveTransfer({ restaurantId: shop.id, transferId: t4.id, userId: user.id })
  await closeTransfer({ restaurantId: shop.id, transferId: t4.id, status: 'CANCELLED', userId: user.id })
  const rel = await getLocationBalance({ restaurantId: shop.id, itemId: bun.id, branchId: colombo.id })
  ok('T9.2', 'cancelling releases the reservation', rel.reserved === 0, '0', String(rel.reserved))

  console.log('\n══ TEST 10 — NEGATIVE STOCK PROTECTION ════════════════')
  await throws('T10.1', 'transferring more than held is refused',
    async () => { const t = await requestTransfer({ restaurantId: shop.id, fromBranchId: kandy.id, toBranchId: colombo.id, lines: [{ itemId: patty.id, quantity: 9999 }], userId: user.id }); await approveTransfer({ restaurantId: shop.id, transferId: t.id, userId: user.id }) })
  await throws('T10.2', 'producing without raw materials is refused',
    () => makePatties(4950, `qa-${S}-toomany`))

  console.log('\n══ TEST 11 — ATOMICITY ════════════════════════════════')
  const atomicBefore = await avail(bun.id, colombo.id)
  try {
    await prisma.$transaction(async (tx) => {
      await postMovement(tx, { restaurantId: shop.id, itemId: bun.id, type: 'SALE', quantity: 5, branchId: colombo.id, userId: user.id })
      throw new Error('forced failure after the first deduction')
    })
  } catch { /* expected */ }
  ok('T11.1', 'a mid-transaction failure rolls everything back', await avail(bun.id, colombo.id) === atomicBefore, String(atomicBefore), String(await avail(bun.id, colombo.id)), 'CRITICAL')

  console.log('\n══ TEST 12 — IDEMPOTENCY ══════════════════════════════')
  const sBefore = await avail(patty.id, colombo.id)
  for (let i = 0; i < 5; i++) {
    await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id }))
  }
  ok('T12.1', 'five repeat reconciliations change nothing', await avail(patty.id, colombo.id) === sBefore, String(sBefore), String(await avail(patty.id, colombo.id)), 'CRITICAL')

  console.log('\n══ TEST 13 — PURCHASE RETURN ══════════════════════════')
  const rBefore = await avail(patty.id, colombo.id)
  await createPurchaseReturn({ restaurantId: shop.id, branchId: colombo.id, supplierId: supplier.id, purchaseId: po.id, reason: 'quality', userId: user.id, lines: [{ itemId: patty.id, quantity: 10, unit: 'PIECE' }] })
  ok('T13.1', 'return reduces stock by 10', await avail(patty.id, colombo.id) === rBefore - 10, String(rBefore - 10), String(await avail(patty.id, colombo.id)))
  ok('T13.2', 'logged as RETURN_TO_SUPPLIER', (await prisma.stockMovement.count({ where: { itemId: patty.id, type: 'RETURN_TO_SUPPLIER' } })) === 1)

  console.log('\n══ TEST 14 — ADJUSTMENT ═══════════════════════════════')
  const aBefore = await avail(patty.id, colombo.id)
  await adjustStock({ restaurantId: shop.id, itemId: patty.id, quantity: 2, direction: 'OUT', reason: 'physical count', userId: user.id, branchId: colombo.id })
  ok('T14.1', 'adjustment reduces by 2', await avail(patty.id, colombo.id) === aBefore - 2, String(aBefore - 2), String(await avail(patty.id, colombo.id)))
  await throws('T14.2', 'an adjustment with no reason is refused',
    () => adjustStock({ restaurantId: shop.id, branchId: colombo.id, itemId: patty.id, quantity: 1, direction: 'IN', reason: '', userId: user.id }), 'HIGH')

  console.log('\n══ TEST 15 — LEDGER RECONCILIATION ════════════════════')
  const recon: Array<{ name: string; cached: number; ledger: number; diff: number }> = []
  for (const i of [patty, bun, cheese, meat, season, oil, phPatty]) {
    const r = await recomputeBalance(shop.id, i.id)
    recon.push({ name: i.name.replace(`-${S}`, ''), cached: r.cached, ledger: r.ledger, diff: Math.round((r.cached - r.ledger) * 1e6) / 1e6 })
    ok(`T15.${recon.length}`, `${i.name.replace(`-${S}`, '')} reconciles`, r.matches, String(r.ledger), String(r.cached), 'CRITICAL')
  }

  console.log('\n══ TEST 16 — TENANT ISOLATION ═════════════════════════')
  await throws('T16.1', 'cross-tenant stock movement refused',
    () => prisma.$transaction((tx) => postMovement(tx, { restaurantId: other.id, branchId: otherBranch, itemId: patty.id, type: 'SALE', quantity: 1, userId: user.id })))
  await throws('T16.2', 'cross-tenant transfer refused',
    () => requestTransfer({ restaurantId: other.id, fromBranchId: colombo.id, toBranchId: kandy.id, lines: [{ itemId: patty.id, quantity: 1 }], userId: user.id }))
  await throws('T16.3', 'cross-tenant production refused',
    () => produceItem({
      restaurantId: other.id, branchId: ph.id, userId: user.id, clientRequestId: `qa-${S}-xt`,
      output: { name: 'Their patty', quantity: 1, unit: 'PIECE' },
      ingredients: [{ itemId: meat.id, quantity: 1, unit: 'KG' }],
    }))
  await throws('T16.4', 'cross-tenant purchase refused',
    () => createPurchaseOrder({ restaurantId: other.id, branchId: otherBranch, lines: [{ itemId: patty.id, quantity: 1, unitCost: 1 }] }))
  ok('T16.5', 'other tenant sees no stock rows',
    (await prisma.inventoryStock.count({ where: { restaurantId: other.id } })) === 0, '0', '', 'CRITICAL')

  console.log('\n══ RECONCILIATION ═════════════════════════════════════')
  console.log('  item              cached   ledger    diff')
  for (const r of recon) {
    console.log(`  ${r.name.padEnd(18)}${String(r.cached).padStart(7)}${String(r.ledger).padStart(9)}${String(r.diff).padStart(8)}`)
  }

  // cleanup
  const ids = shops
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: { in: ids } } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: { in: ids } } } })
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: { in: ids } } } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: { in: ids } } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.wastageRecord.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.purchaseReturnLine.deleteMany({ where: { return: { restaurantId: { in: ids } } } })
  await prisma.purchaseReturn.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: { in: ids } } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.purchasePriceHistory.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: { in: ids } } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.supplier.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: { in: ids } } } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: { in: ids } } } })
  await prisma.order.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: { in: ids } } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.food.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.category.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.storageLocation.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.branch.deleteMany({ where: { restaurantId: { in: ids } } })
  await prisma.restaurant.deleteMany({ where: { id: { in: ids } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══`)
  if (failures.length) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  [${f.severity}] ${f.id} — expected ${f.expected}, got ${f.actual}`)
  }
  console.log()
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('\nCRASHED:', e); await prisma.$disconnect(); process.exit(1) })
