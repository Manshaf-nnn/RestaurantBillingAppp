/**
 * The Expiry board is fed by deliveries.
 *
 * ── Why it was permanently blank ────────────────────────────────────────────
 *
 * `/dashboard/inventory/expiry` reads `StockBatch`. The only thing that ever
 * creates one is `upsertBatch`, called from `receiving.ts` behind
 * `if (item.trackBatches)`. And `trackBatches` had NO user interface anywhere
 * in the application — not on the item form, not on the receiving screen, not
 * in settings — so it was false on every row of every restaurant.
 *
 * The whole chain below it was already written and correct: the receiving screen
 * has an expiry input, `GoodsReceiptLine` and `StockMovement` both carry the
 * date, `allocateFefo` draws the earliest-expiring lot first, the board buckets
 * by days remaining. One unreachable boolean kept all of it dark, including
 * FEFO, which had nothing to allocate.
 *
 * The item form now has a single "This goes off" checkbox that sets the three
 * flags together. Two separate boxes would let somebody produce
 * `trackExpiry && !trackBatches`, which is a trap: the receiving screen REFUSES
 * to submit without a date for such an item, and nothing is then created to
 * hang the date on. `receiving.ts` gates on either flag now, which is what the
 * legacy case below covers.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/expiry-tracking-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { createPurchaseOrder, setPurchaseStatus, upsertSupplierItem } from '../src/features/purchasing/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import { getExpirySummary, listExpiringStock } from '../src/features/inventory/batches'

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

  const shop = await prisma.restaurant.create({
    data: { name: `Exp ${stamp}`, slug: `exp-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: shop.id, name: 'Dairy Co' },
  })

  const mkItem = (name: string, flags: Record<string, boolean> = {}) =>
    prisma.inventoryItem.create({
      data: {
        restaurantId: shop.id, name, unit: 'LITRE', quantity: 0, costPerUnit: 20_000,
        ...flags,
      },
    })

  /** Raise, approve and receive one line, returning the receipt. */
  async function deliver(
    itemId: string,
    quantity: number,
    expiryDate: Date | null,
  ) {
    const po = await createPurchaseOrder({
      restaurantId: shop.id, supplierId: supplier.id, branchId: main.id,
      lines: [{ itemId, quantity, unit: 'LITRE', unitCost: 20_000 }],
    })
    await setPurchaseStatus({ restaurantId: shop.id, purchaseId: po.id, status: 'APPROVED' })
    const item = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po.id } })
    return receiveGoods({
      restaurantId: shop.id,
      purchaseId: po.id,
      lines: [{ purchaseItemId: item.id, acceptedQty: quantity, expiryDate }],
    })
  }

  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000)

  console.log('\n── a delivery of a perishable creates a batch ──')

  const milk = await mkItem('Milk', { trackBatches: true, trackExpiry: true, useFefo: true })
  const friday = inDays(4)
  await deliver(milk.id, 12, friday)

  const batch = await prisma.stockBatch.findFirst({ where: { itemId: milk.id } })
  // Nothing in the app had ever written one of these.
  check('a StockBatch exists', batch !== null)
  check('carrying the expiry date', batch?.expiryDate?.toDateString() === friday.toDateString())
  check('with the delivered quantity still on it', batch?.remainingQty === 12, `${batch?.remainingQty}`)
  check('at the receiving branch', batch?.branchId === main.id)

  const movement = await prisma.stockMovement.findFirstOrThrow({
    where: { itemId: milk.id, type: 'PURCHASE' },
  })
  check('and the movement is stamped with the lot', movement.batchId === batch?.id)

  console.log('\n── the board can see it ──')

  const expiring = await listExpiringStock({
    restaurantId: shop.id, branchId: main.id, periodDays: 30,
  })
  check('the batch reaches the expiry board', expiring.some((row) => row.itemId === milk.id))
  const summary = await getExpirySummary({
    restaurantId: shop.id, branchId: main.id, periodDays: 30,
  })
  // Four days out lands in the "within a week" bucket, with money against it.
  check(
    'and is bucketed by how soon, with value at risk',
    summary.WITHIN_7.count === 1 && summary.WITHIN_7.value > 0,
    JSON.stringify(summary.WITHIN_7),
  )

  console.log('\n── a second delivery is its own lot ──')

  await deliver(milk.id, 6, inDays(11))
  const lots = await prisma.stockBatch.findMany({
    where: { itemId: milk.id }, orderBy: { expiryDate: 'asc' },
  })
  // The point of batches: this crate goes off on Friday, the next on Sunday.
  check('two deliveries are two lots, not one', lots.length === 2, `${lots.length}`)
  check('the earlier one sorts first', lots[0].expiryDate! < lots[1].expiryDate!)

  console.log('\n── FEFO draws the earliest-expiring lot first ──')

  const { adjustStock } = await import('../src/features/inventory/operations')
  await adjustStock({
    restaurantId: shop.id, branchId: main.id, itemId: milk.id, quantity: 12,
    direction: 'OUT', reason: 'used in service', userId: null as unknown as string,
  })
  const after = await prisma.stockBatch.findMany({
    where: { itemId: milk.id }, orderBy: { expiryDate: 'asc' },
  })
  check('the soonest-to-expire lot is emptied first', after[0].remainingQty === 0, `${after[0].remainingQty}`)
  check('and the later one is untouched', after[1].remainingQty === 6, `${after[1].remainingQty}`)

  console.log('\n── the legacy trap: expiry on, batches off ──')

  /*
   * Rows created before the single checkbox could hold `trackExpiry` without
   * `trackBatches`. The receiving screen demands a date for them and the old
   * gate then created nothing — so the date was written to the receipt line and
   * read by nobody, and the item could never appear on the board.
   */
  const yoghurt = await mkItem('Yoghurt', { trackExpiry: true, trackBatches: false })
  await deliver(yoghurt.id, 4, inDays(3))
  const rescued = await prisma.stockBatch.findFirst({ where: { itemId: yoghurt.id } })
  check('a batch is created anyway', rescued !== null)
  check(
    'so it reaches the board',
    (await listExpiringStock({ restaurantId: shop.id, branchId: main.id, periodDays: 30 }))
      .some((row) => row.itemId === yoghurt.id),
  )

  console.log('\n── an item that does not expire creates nothing ──')

  const rice = await mkItem('Rice')
  await deliver(rice.id, 20, null)
  check(
    'no batch for a non-perishable',
    (await prisma.stockBatch.count({ where: { itemId: rice.id } })) === 0,
  )

  console.log('\n── the supplier price list teaches the item its pack size ──')

  /*
   * `toBaseUnits` throws rather than guessing, and `assertConvertible` calls it
   * when an order is RAISED — so an item bought by the box with no pack size
   * blocked the purchase order itself, pointing at a field the owner had to go
   * and find. The same question is answered on the supplier price list.
   */
  const oil = await mkItem('Oil')
  await upsertSupplierItem({
    restaurantId: shop.id, supplierId: supplier.id, itemId: oil.id,
    purchaseUnit: 'BOX', unitsPerPurchaseUnit: 12, price: 100_000,
  })
  const taught = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: oil.id } })
  check('the item learns the purchase unit', taught.purchaseUnit === 'BOX')
  check('and how many are in one', taught.unitsPerPurchaseUnit === 12)

  // Never an overwrite: two suppliers can pack the same thing differently, and
  // the item's own columns are the restaurant's convention.
  const other = await prisma.supplier.create({
    data: { restaurantId: shop.id, name: 'Other Co' },
  })
  await upsertSupplierItem({
    restaurantId: shop.id, supplierId: other.id, itemId: oil.id,
    purchaseUnit: 'PACK', unitsPerPurchaseUnit: 6, price: 60_000,
  })
  const unchanged = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: oil.id } })
  check(
    'a second supplier does not overwrite it',
    unchanged.purchaseUnit === 'BOX' && unchanged.unitsPerPurchaseUnit === 12,
    `${unchanged.purchaseUnit} / ${unchanged.unitsPerPurchaseUnit}`,
  )

  await prisma.stockBatch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: shop.id } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: shop.id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.supplierItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: shop.id } })
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
