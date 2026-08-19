/** Phase 4: suppliers, purchase orders, receiving, returns. */
import { prisma } from '../src/server/db/prisma'
import {
  createPurchaseOrder, setPurchaseStatus, upsertSupplierItem, canTransitionPurchase,
} from '../src/features/purchasing/service'
import { receiveGoods, createPurchaseReturn } from '../src/features/purchasing/receiving'
import { getReorderSuggestions, getPriceTrend } from '../src/features/purchasing/suggestions'
import { setOpeningBalance } from '../src/features/inventory/operations'
import { recomputeBalance } from '../src/features/inventory/ledger'

let pass = 0, fail = 0
const items: string[] = [], suppliers: string[] = [], pos: string[] = []

function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }
async function throws(n: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${n} — expected rejection`) }
  catch (e) { const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${n} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${n} (${c ?? 'rejected'})`) } }
}
const qty = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantity

async function main() {
  const shop = await prisma.restaurant.findFirstOrThrow({ where: { slug: 'the-copper-spoon' } })
  const other = await prisma.restaurant.findFirstOrThrow({ where: { slug: 'kava' } })
  const user = await prisma.user.findFirstOrThrow({ where: { restaurantId: shop.id, deletedAt: null } })
  const S = Date.now().toString(36)

  console.log('\n── 1. Supplier ──────────────────────────────────────────')
  const supplier = await prisma.supplier.create({
    data: {
      restaurantId: shop.id, name: `Fresh Farms ${S}`, company: 'Fresh Farms (Pvt) Ltd',
      contactName: 'Nimal', phone: '0771234567', email: 'nimal@freshfarms.lk',
      paymentTerms: 'NET_30', taxNumber: 'VAT-12345',
    },
  })
  suppliers.push(supplier.id)
  ok('supplier created with company and terms', supplier.company !== null && supplier.paymentTerms === 'NET_30')

  const chicken = await prisma.inventoryItem.create({
    data: {
      restaurantId: shop.id, name: `Chicken ${S}`, unit: 'KG',
      reorderLevel: 20, maxStock: 60, purchaseUnit: 'BOX', unitsPerPurchaseUnit: 10,
    },
  })
  items.push(chicken.id)

  const link = await upsertSupplierItem({
    restaurantId: shop.id, supplierId: supplier.id, itemId: chicken.id,
    supplierSku: 'FF-CHK-10', purchaseUnit: 'BOX', unitsPerPurchaseUnit: 10,
    price: 1_000_00, leadTimeDays: 2, minOrderQty: 1, isPreferred: true,
  })
  ok('supplier-specific price, SKU, lead time and MOQ stored',
    link.supplierSku === 'FF-CHK-10' && link.leadTimeDays === 2 && link.minOrderQty === 1)

  const second = await prisma.supplier.create({ data: { restaurantId: shop.id, name: `Backup Foods ${S}` } })
  suppliers.push(second.id)
  await upsertSupplierItem({ restaurantId: shop.id, supplierId: second.id, itemId: chicken.id, price: 1_200_00 })
  const links = await prisma.supplierItem.findMany({ where: { itemId: chicken.id } })
  ok('one item can have several suppliers', links.length === 2)
  ok('only one is preferred', links.filter((l) => l.isPreferred).length === 1)

  console.log('\n── 2. Purchase order ────────────────────────────────────')
  const po = await createPurchaseOrder({
    restaurantId: shop.id, supplierId: supplier.id, userId: user.id,
    lines: [{ itemId: chicken.id, quantity: 100, unit: 'BOX', unitCost: 1_000_00 }],
    taxTotal: 5_000_00,
  })
  pos.push(po.id)
  ok('PO number generated', /^PO-\d{6}$/.test(po.number), po.number)
  ok('starts as DRAFT', po.status === 'DRAFT')
  ok('subtotal = 100 × 1000', po.subtotal === 100 * 1_000_00, `got ${po.subtotal}`)
  ok('total includes tax', po.total === 100 * 1_000_00 + 5_000_00, `got ${po.total}`)
  ok('creating a PO does NOT change stock', await qty(chicken.id) === 0, `got ${await qty(chicken.id)}`)

  console.log('\n── 3. Approval workflow ─────────────────────────────────')
  await throws('receiving before approval is refused',
    () => receiveGoods({ restaurantId: shop.id, purchaseId: po.id, lines: [], userId: user.id }),
    'PO_NOT_APPROVED')
  ok('DRAFT → RECEIVED is not a legal jump', !canTransitionPurchase('DRAFT', 'RECEIVED'))
  ok('APPROVED → ORDERED is legal', canTransitionPurchase('APPROVED', 'ORDERED'))
  ok('a RECEIVED order is terminal', !canTransitionPurchase('RECEIVED', 'ORDERED'))

  await setPurchaseStatus({ restaurantId: shop.id, purchaseId: po.id, status: 'PENDING_APPROVAL' })
  const approved = await setPurchaseStatus({ restaurantId: shop.id, purchaseId: po.id, status: 'APPROVED', userId: user.id })
  ok('approval records who and when', approved.approvedById === user.id && approved.approvedAt !== null)
  await setPurchaseStatus({ restaurantId: shop.id, purchaseId: po.id, status: 'ORDERED' })
  ok('still no stock after ordering', await qty(chicken.id) === 0)

  console.log('\n── 4. Partial receipt: 90 of 100 ────────────────────────')
  const line = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po.id } })
  const r1 = await receiveGoods({
    restaurantId: shop.id, purchaseId: po.id, userId: user.id, supplierRef: 'DN-4471',
    lines: [{ purchaseItemId: line.id, acceptedQty: 90 }],
  })
  ok('GRN number generated', /^GRN-\d{6}$/.test(r1.receipt.number), r1.receipt.number)
  ok('order becomes PARTIALLY_RECEIVED', r1.status === 'PARTIALLY_RECEIVED', r1.status)
  // 90 boxes × 10 kg = 900 kg
  ok('stock is 900 kg (90 boxes × 10 kg)', await qty(chicken.id) === 900, `got ${await qty(chicken.id)}`)

  const purchaseRows = await prisma.stockMovement.findMany({ where: { purchaseId: po.id, type: 'PURCHASE' } })
  ok('a PURCHASE ledger row was written', purchaseRows.length === 1)
  ok('the row records the entered unit', purchaseRows[0].enteredUnit === 'BOX' && purchaseRows[0].quantityEntered === 90)
  const chickenAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: chicken.id } })
  // 1000 per box ÷ 10 kg = 100 per kg
  ok('cost converted to base units (100/kg)', chickenAfter.costPerUnit === 100_00, `got ${chickenAfter.costPerUnit}`)

  console.log('\n── 5. Remaining 10 ──────────────────────────────────────')
  const r2 = await receiveGoods({
    restaurantId: shop.id, purchaseId: po.id, userId: user.id,
    lines: [{ purchaseItemId: line.id, acceptedQty: 10 }],
  })
  ok('order becomes RECEIVED', r2.status === 'RECEIVED', r2.status)
  ok('stock is 1000 kg', await qty(chicken.id) === 1000, `got ${await qty(chicken.id)}`)
  const done = await prisma.purchase.findUniqueOrThrow({ where: { id: po.id } })
  ok('receivedAt is stamped', done.receivedAt !== null)
  await throws('over-receiving is refused',
    () => receiveGoods({ restaurantId: shop.id, purchaseId: po.id, userId: user.id,
      lines: [{ purchaseItemId: line.id, acceptedQty: 1 }] }), 'RECEIPT_OVER')

  console.log('\n── 6. Damaged goods: 95 accepted, 5 rejected ────────────')
  const rice = await prisma.inventoryItem.create({
    data: { restaurantId: shop.id, name: `Rice ${S}`, unit: 'KG', reorderLevel: 10 },
  })
  items.push(rice.id)
  const po2 = await createPurchaseOrder({
    restaurantId: shop.id, supplierId: supplier.id, userId: user.id,
    lines: [{ itemId: rice.id, quantity: 100, unit: 'KG', unitCost: 500_00 }],
  })
  pos.push(po2.id)
  await setPurchaseStatus({ restaurantId: shop.id, purchaseId: po2.id, status: 'APPROVED', userId: user.id })
  const line2 = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po2.id } })
  const r3 = await receiveGoods({
    restaurantId: shop.id, purchaseId: po2.id, userId: user.id,
    lines: [{ purchaseItemId: line2.id, acceptedQty: 95, rejectedQty: 5, rejectReason: 'torn bags' }],
  })
  ok('only the accepted 95 enters stock', await qty(rice.id) === 95, `got ${await qty(rice.id)}`)
  ok('rejected goods are recorded on the line',
    (await prisma.purchaseItem.findUniqueOrThrow({ where: { id: line2.id } })).rejectedQty === 5)
  ok('order is RECEIVED — 95 + 5 accounts for all 100', r3.status === 'RECEIVED', r3.status)
  const riceRows = await prisma.stockMovement.count({ where: { itemId: rice.id } })
  ok('rejected goods never entered the ledger', riceRows === 1, `${riceRows} rows`)

  console.log('\n── 7. Purchase return ───────────────────────────────────')
  const before = await qty(rice.id)
  const ret = await createPurchaseReturn({
    restaurantId: shop.id, supplierId: supplier.id, purchaseId: po2.id, userId: user.id,
    reason: 'quality complaint',
    lines: [{ itemId: rice.id, quantity: 15, unit: 'KG' }],
  })
  ok('return number generated', /^PRT-\d{6}$/.test(ret.number), ret.number)
  ok('stock drops by 15', await qty(rice.id) === before - 15, `${before} -> ${await qty(rice.id)}`)
  const retRow = await prisma.stockMovement.findFirstOrThrow({
    where: { itemId: rice.id, type: 'RETURN_TO_SUPPLIER' },
  })
  ok('logged as RETURN_TO_SUPPLIER', retRow.type === 'RETURN_TO_SUPPLIER')
  ok('the return references its record', retRow.referenceType === 'PurchaseReturn' && retRow.referenceId === ret.id)
  await throws('a return with no reason is refused',
    () => createPurchaseReturn({ restaurantId: shop.id, reason: '', lines: [{ itemId: rice.id, quantity: 1 }], userId: user.id }),
    'RETURN_NO_REASON')

  console.log('\n── 8. Ledger reconciles ─────────────────────────────────')
  const c1 = await recomputeBalance(shop.id, chicken.id)
  const c2 = await recomputeBalance(shop.id, rice.id)
  ok('chicken: cached balance = replayed ledger', c1.matches, `${c1.cached} vs ${c1.ledger}`)
  ok('rice: cached balance = replayed ledger', c2.matches, `${c2.cached} vs ${c2.ledger}`)

  console.log('\n── 9. Price history ─────────────────────────────────────')
  const trend = await getPriceTrend({ restaurantId: shop.id, itemId: chicken.id })
  ok('every receipt recorded a price point', trend.points.length === 2, `got ${trend.points.length}`)
  ok('the supplier is named on each point', trend.points.every((p) => p.supplierName !== null))
  ok('prices are normalised per base unit', trend.latest === 100_00, `got ${trend.latest}`)

  console.log('\n── 10. Reorder suggestions ──────────────────────────────')
  const low = await prisma.inventoryItem.create({
    data: { restaurantId: shop.id, name: `Onion ${S}`, unit: 'KG', reorderLevel: 20, maxStock: 50 },
  })
  items.push(low.id)
  await setOpeningBalance({ restaurantId: shop.id, itemId: low.id, quantity: 12, userId: user.id })
  await upsertSupplierItem({
    restaurantId: shop.id, supplierId: supplier.id, itemId: low.id, price: 200_00, leadTimeDays: 1,
  })

  const suggestions = await getReorderSuggestions({ restaurantId: shop.id })
  const onion = suggestions.find((s) => s.itemId === low.id)
  ok('a low item is suggested', Boolean(onion))
  ok('current 12, reorder 20 → suggest 38 (up to par 50)', onion?.suggestedQty === 38, `got ${onion?.suggestedQty}`)
  ok('the preferred supplier is proposed', onion?.supplierName === supplier.name)
  ok('an estimated cost is given', (onion?.estimatedCost ?? 0) > 0)
  ok('healthy stock is not suggested', !suggestions.some((s) => s.itemId === chicken.id))

  console.log('\n── 11. Tenant isolation ─────────────────────────────────')
  await throws('creating a PO for another tenant’s item is refused',
    () => createPurchaseOrder({ restaurantId: other.id, lines: [{ itemId: chicken.id, quantity: 1, unitCost: 1 }] }))
  await throws('receiving another tenant’s PO is refused',
    () => receiveGoods({ restaurantId: other.id, purchaseId: po.id, lines: [], userId: user.id }))
  await throws('linking another tenant’s item to a supplier is refused',
    () => upsertSupplierItem({ restaurantId: other.id, supplierId: supplier.id, itemId: chicken.id }))
  const leak = await prisma.purchase.findFirst({ where: { id: po.id, restaurantId: other.id } })
  ok('a PO id from another tenant does not resolve', leak === null)

  // cleanup
  await prisma.purchasePriceHistory.deleteMany({ where: { itemId: { in: items } } })
  await prisma.purchaseReturnLine.deleteMany({ where: { itemId: { in: items } } })
  await prisma.purchaseReturn.deleteMany({ where: { restaurantId: shop.id, supplierId: { in: suppliers } } })
  await prisma.goodsReceiptLine.deleteMany({ where: { itemId: { in: items } } })
  await prisma.goodsReceipt.deleteMany({ where: { purchaseId: { in: pos } } })
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: items } } })
  await prisma.purchaseItem.deleteMany({ where: { purchaseId: { in: pos } } })
  await prisma.purchase.deleteMany({ where: { id: { in: pos } } })
  await prisma.supplierItem.deleteMany({ where: { itemId: { in: items } } })
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items } } })
  await prisma.supplier.deleteMany({ where: { id: { in: suppliers } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nCRASHED:', e)
  await prisma.$disconnect()
  process.exit(1)
})
