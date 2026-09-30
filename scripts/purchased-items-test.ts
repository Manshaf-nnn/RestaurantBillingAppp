/**
 * The "Purchased items" section of the purchasing report.
 *
 * What it pins is the choice of source: the STOCK LEDGER, not the purchase
 * orders. A delivery against an order and a cash-and-carry "stock in" with a
 * price are both purchases to the owner; both are PURCHASE movements, in the
 * item's own unit, valued at what was actually paid, stamped with the branch
 * they landed at. A return to the supplier is the same fact in reverse and is
 * shown beside the purchase, not netted out of it.
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { listPurchasedItems } from '../src/features/purchasing/purchased-items'
import { resolveRange } from '../src/features/reports/range'

let passed = 0
let failed = 0
function check(what: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${what}`) }
  else { failed += 1; console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`) }
}

const S = Date.now().toString(36)
const pause = () => new Promise((resolve) => setTimeout(resolve, 5))

async function main() {
  const shop = await prisma.restaurant.create({
    data: { name: `Bought ${S}`, slug: `bought-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  const stranger = await prisma.restaurant.create({
    data: { name: `Neighbour ${S}`, slug: `neighbour-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  const colombo = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Colombo', code: 'CMB', isDefault: true },
  })
  const ampara = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Ampara', code: 'AMP' },
  })
  const dairy = await prisma.inventoryCategory.create({
    data: { restaurantId: shop.id, name: `Dairy ${S}` },
  })
  const cheese = await prisma.inventoryItem.create({
    data: {
      restaurantId: shop.id, name: `Cheese ${S}`, sku: `CHS-${S}`, unit: 'KG',
      costPerUnit: 1_000_00, categoryId: dairy.id,
    },
  })
  const flour = await prisma.inventoryItem.create({
    data: { restaurantId: shop.id, name: `Flour ${S}`, unit: 'KG', costPerUnit: 100_00 },
  })
  const acme = await prisma.supplier.create({ data: { restaurantId: shop.id, name: `Acme ${S}` } })
  const po = await prisma.purchase.create({
    data: {
      restaurantId: shop.id, branchId: colombo.id, supplierId: acme.id,
      number: `PO-${S}`, status: 'APPROVED', total: 8_300_00, subtotal: 8_300_00, orderedAt: new Date(),
    },
  })

  const post = (params: Parameters<typeof postMovement>[1]) =>
    prisma.$transaction((tx) => postMovement(tx, params))

  // Two deliveries of cheese against the order, one per branch, at different prices.
  await post({
    restaurantId: shop.id, itemId: cheese.id, type: 'PURCHASE', quantity: 5,
    unitCost: 1_000_00, totalValue: 5_000_00, branchId: colombo.id, purchaseId: po.id,
    reason: 'Received on GRN-1',
  })
  await pause()
  await post({
    restaurantId: shop.id, itemId: cheese.id, type: 'PURCHASE', quantity: 3,
    unitCost: 1_100_00, totalValue: 3_300_00, branchId: ampara.id, purchaseId: po.id,
    reason: 'Received on GRN-2',
  })
  await pause()
  // Flour bought for cash and recorded as stock in, with a price, no order.
  await post({
    restaurantId: shop.id, itemId: flour.id, type: 'PURCHASE', quantity: 10,
    unitCost: 100_00, branchId: colombo.id, reason: 'Market run',
  })
  await pause()
  // A kilo of cheese sent back from Colombo.
  await post({
    restaurantId: shop.id, itemId: cheese.id, type: 'RETURN_TO_SUPPLIER', quantity: 1,
    branchId: colombo.id, purchaseId: po.id, reason: 'Mouldy',
  })

  const range = resolveRange({ preset: 'TODAY', timeZone: shop.timezone })

  console.log('\n── Every item, from the ledger ───────────────────────────')
  const all = await listPurchasedItems({ restaurantId: shop.id, range })
  check('two items were bought', all.rows.length === 2, String(all.rows.length))
  check('biggest spend first', all.rows[0]?.key === cheese.id)

  const ch = all.rows.find((r) => r.key === cheese.id)!
  check('cheese: 8 kg across both deliveries', ch.quantity === 8, String(ch.quantity))
  check('cheese: two deliveries', ch.deliveries === 2, String(ch.deliveries))
  check('cheese: spend is what was paid, 8,300.00', ch.value === 8_300_00, String(ch.value))
  check('cheese: average paid per kg is 1,037.50', ch.averageUnitCost === 1_037_50, String(ch.averageUnitCost))
  check('cheese: last paid is the Ampara delivery, 1,100.00', ch.lastUnitCost === 1_100_00, String(ch.lastUnitCost))
  check('cheese: last bought is stamped', ch.lastBoughtAt !== null)
  check('cheese: supplier is the order’s', ch.suppliers.length === 1 && ch.suppliers[0] === `Acme ${S}`, ch.suppliers.join(','))
  check('cheese: both locations named', ch.locations.length === 2 && ch.locations.includes('Colombo') && ch.locations.includes('Ampara'), ch.locations.join(','))
  check('cheese: the return is shown beside it, not netted out', ch.returnedQuantity === 1 && ch.quantity === 8, `${ch.returnedQuantity}/${ch.quantity}`)
  check('cheese: the return left at the Colombo delivery’s price', ch.returnedValue === 1_000_00, String(ch.returnedValue))
  check('cheese: category and unit travel with the row', ch.category === `Dairy ${S}` && ch.unit === 'KG' && ch.sku === `CHS-${S}`)

  const fl = all.rows.find((r) => r.key === flour.id)!
  check('flour: a stock-in with a price is a purchase', fl.quantity === 10 && fl.value === 1_000_00, `${fl.quantity} @ ${fl.value}`)
  check('flour: named as direct stock in, not "no supplier"', fl.suppliers[0] === 'Direct stock in', fl.suppliers.join(','))
  check('flour: uncategorised reads as such', fl.category === 'Uncategorised', fl.category)

  check('totals: 2 items, 3 deliveries, 9,300.00 spent, 1,000.00 returned',
    all.totals.items === 2 && all.totals.deliveries === 3 && all.totals.value === 9_300_00 && all.totals.returnedValue === 1_000_00,
    JSON.stringify(all.totals))

  console.log('\n── The location filter narrows every figure ─────────────')
  const amp = await listPurchasedItems({ restaurantId: shop.id, range, branchIds: [ampara.id] })
  check('only cheese reached Ampara', amp.rows.length === 1 && amp.rows[0].key === cheese.id)
  check('at Ampara: 3 kg for 3,300.00', amp.rows[0].quantity === 3 && amp.rows[0].value === 3_300_00)
  check('at Ampara: one location named', amp.rows[0].locations.length === 1 && amp.rows[0].locations[0] === 'Ampara')
  check('at Ampara: no returns', amp.rows[0].returnedQuantity === 0)
  const nowhere = await listPurchasedItems({ restaurantId: shop.id, range, branchIds: [] })
  check('confined to nowhere sees nothing', nowhere.rows.length === 0)

  console.log('\n── The period and the tenant ────────────────────────────')
  const lastYear = resolveRange({
    preset: 'CUSTOM', from: '2020-01-01', to: '2020-01-31', timeZone: shop.timezone,
  })
  const old = await listPurchasedItems({ restaurantId: shop.id, range: lastYear })
  check('nothing outside the period', old.rows.length === 0 && old.totals.value === 0)
  const theirs = await listPurchasedItems({ restaurantId: stranger.id, range })
  check('a neighbour reads nothing', theirs.rows.length === 0)
  const capped = await listPurchasedItems({ restaurantId: shop.id, range, limit: 1 })
  check('a limit caps the rows but the totals still cover everything', capped.rows.length === 1 && capped.totals.items === 2)

  await prisma.stockMovementLot.deleteMany({ where: { movement: { restaurantId: shop.id } } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.purchase.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryCategory.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.deleteMany({ where: { id: { in: [shop.id, stranger.id] } } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
