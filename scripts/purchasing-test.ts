/**
 * Purchase orders and goods receipts, end to end.
 *
 * The complaint list said "unable to add more than 3 items" and "no option to
 * create a GRN from an approved purchase order". Neither was true of this
 * codebase in the way it sounded, and both pointed at something real:
 *
 *   · There is no line-item cap anywhere — not in the form, the zod schema, the
 *     service, or the compiled bundle. Proved below with twelve lines, because
 *     "we checked and there is no limit" is worth less than a test that fails
 *     the day someone adds one.
 *
 *   · Receiving worked and lived at the bottom of an individual order's page,
 *     so the only way in was to already know the order number. What was missing
 *     was the way in, not the machinery.
 *
 * The rest covers what genuinely was missing or wrong: editing a draft (the
 * service could always do it and nothing ever called it), a line in a unit the
 * item cannot convert (which used to save fine and fail at the van, days
 * later), duplicate lines, receiving somewhere other than where the order said,
 * and the last purchase price.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/purchasing-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  createPurchaseOrder,
  setPurchaseStatus,
  updatePurchaseOrder,
} from '../src/features/purchasing/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import {
  getPoBuilderData,
  getPurchaseDetail,
  getReceiptDetail,
  listAwaitingDelivery,
  listPurchaseOrders,
} from '../src/features/purchasing/queries'

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
    data: { name: `Buy ${stamp}`, slug: `buy-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: 'ABC Distributors' },
  })

  // Twelve items, so the "3 items" claim can actually be tested.
  const items = []
  for (let i = 1; i <= 12; i += 1) {
    items.push(
      await prisma.inventoryItem.create({
        data: {
          restaurantId: restaurant.id,
          name: `Item ${i}`,
          unit: 'KG',
          quantity: 0,
          costPerUnit: 10_000,
        },
      }),
    )
  }

  console.log('\n── a purchase order takes as many lines as you give it ──')

  const big = await createPurchaseOrder({
    restaurantId: restaurant.id,
    supplierId: supplier.id,
    branchId: main.id,
    lines: items.map((item, index) => ({
      itemId: item.id,
      quantity: index + 1,
      unit: 'KG' as const,
      unitCost: 10_000,
    })),
  })

  const savedLines = await prisma.purchaseItem.count({ where: { purchaseId: big.id } })
  check('twelve lines save', savedLines === 12, `${savedLines}`)

  const readBack = await getPurchaseDetail({
    restaurantId: restaurant.id,
    purchaseId: big.id,
    currency: 'LKR',
  })
  check('and twelve come back', readBack.lines.length === 12, `${readBack.lines.length}`)
  check(
    'with the totals added up correctly',
    // 1+2+…+12 = 78 units at 10,000 each
    readBack.subtotal === 78 * 10_000,
    `${readBack.subtotal}`,
  )
  check('and the destination recorded', readBack.branchName === 'Main', `${readBack.branchName}`)

  console.log('\n── bad lines are refused when they are written ──')

  await refuses(
    'the same item twice is refused',
    () =>
      createPurchaseOrder({
        restaurantId: restaurant.id,
        supplierId: supplier.id,
        branchId: main.id,
        lines: [
          { itemId: items[0].id, quantity: 5, unit: 'KG', unitCost: 10_000 },
          { itemId: items[0].id, quantity: 3, unit: 'KG', unitCost: 10_000 },
        ],
      }),
    /twice/i,
  )

  /*
   * The second half of "the item is on the order but the GRN won't take it".
   * A line in BOX against an item that has never said how many kilos are in a
   * box used to save perfectly and then throw at goods receipt, inside the
   * transaction that moves stock — so it failed days later with someone
   * standing beside a pallet.
   */
  await refuses(
    'a unit the item cannot convert is refused at save time',
    () =>
      createPurchaseOrder({
        restaurantId: restaurant.id,
        supplierId: supplier.id,
        branchId: main.id,
        lines: [{ itemId: items[0].id, quantity: 2, unit: 'BOX', unitCost: 10_000 }],
      }),
    /cannot convert|purchase unit/i,
  )

  console.log('\n── a draft can be corrected ──')

  const draft = await createPurchaseOrder({
    restaurantId: restaurant.id,
    supplierId: supplier.id,
    branchId: main.id,
    lines: [{ itemId: items[0].id, quantity: 100, unit: 'KG', unitCost: 10_000 }],
  })
  check('a new order starts as a draft', draft.status === 'DRAFT', draft.status)

  await updatePurchaseOrder({
    restaurantId: restaurant.id,
    purchaseId: draft.id,
    lines: [
      { itemId: items[0].id, quantity: 60, unit: 'KG', unitCost: 10_000 },
      { itemId: items[1].id, quantity: 40, unit: 'KG', unitCost: 12_000 },
    ],
  })

  const edited = await getPurchaseDetail({
    restaurantId: restaurant.id,
    purchaseId: draft.id,
    currency: 'LKR',
  })
  check('the lines are replaced, not appended', edited.lines.length === 2, `${edited.lines.length}`)
  check('the number is unchanged', edited.number === draft.number)
  check('and the total recalculated', edited.subtotal === 60 * 10_000 + 40 * 12_000, `${edited.subtotal}`)

  console.log('\n── receiving against an approved order ──')

  const po = await createPurchaseOrder({
    restaurantId: restaurant.id,
    supplierId: supplier.id,
    branchId: main.id,
    lines: [{ itemId: items[2].id, quantity: 100, unit: 'KG', unitCost: 18_000 }],
  })

  /*
   * The first and most likely cause of the reported bug: a new order is DRAFT,
   * DRAFT cannot be received, and the receive form simply did not render. The
   * order was right and the screen said nothing at all.
   */
  await refuses(
    'a draft order cannot be received against',
    () =>
      receiveGoods({
        restaurantId: restaurant.id,
        purchaseId: po.id,
        lines: [{ purchaseItemId: 'x', acceptedQty: 1 }],
      }),
    /approve the order/i,
  )

  await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: po.id, status: 'APPROVED' })

  const waiting = await listAwaitingDelivery({ restaurantId: restaurant.id })
  check(
    'an approved order appears on the receiving screen',
    waiting.some((row) => row.id === po.id),
    'the storekeeper has no way to find it',
  )
  check(
    'with what is still to come',
    waiting.find((row) => row.id === po.id)?.outstandingQty === 100,
    `${waiting.find((row) => row.id === po.id)?.outstandingQty}`,
  )

  const line = (
    await getPurchaseDetail({ restaurantId: restaurant.id, purchaseId: po.id, currency: 'LKR' })
  ).lines[0]

  console.log('\n── partial receipt: 100 ordered, 70 received, 30 left ──')

  const first = await receiveGoods({
    restaurantId: restaurant.id,
    purchaseId: po.id,
    supplierRef: 'INV-9001',
    lines: [{ purchaseItemId: line.id, acceptedQty: 70 }],
  })
  check('the order is part received', first.status === 'PARTIALLY_RECEIVED', first.status)

  const afterFirst = await getPurchaseDetail({
    restaurantId: restaurant.id,
    purchaseId: po.id,
    currency: 'LKR',
  })
  check('70 are recorded', afterFirst.lines[0].receivedQty === 70, `${afterFirst.lines[0].receivedQty}`)
  check('30 remain outstanding', afterFirst.lines[0].outstanding === 30, `${afterFirst.lines[0].outstanding}`)

  const stillWaiting = await listAwaitingDelivery({ restaurantId: restaurant.id })
  check(
    'and it is still on the receiving screen for the rest',
    stillWaiting.find((row) => row.id === po.id)?.outstandingQty === 30,
    `${stillWaiting.find((row) => row.id === po.id)?.outstandingQty}`,
  )

  await refuses(
    'more than was ordered is refused',
    () =>
      receiveGoods({
        restaurantId: restaurant.id,
        purchaseId: po.id,
        lines: [{ purchaseItemId: line.id, acceptedQty: 40 }],
      }),
    /more than the 100 ordered/i,
  )

  console.log('\n── the rest arrives, somewhere else ──')

  /*
   * Receiving was hard-wired to the order's own branch, so a van diverted to
   * another site could not be recorded truthfully — the stock went onto the
   * wrong shelf in the books and surfaced weeks later as a variance nobody
   * could account for.
   */
  const second = await receiveGoods({
    restaurantId: restaurant.id,
    purchaseId: po.id,
    branchId: kandy.id,
    lines: [{ purchaseItemId: line.id, acceptedQty: 30, unitCost: 20_000 }],
  })
  check('the order is now fully received', second.status === 'RECEIVED', second.status)

  const atKandy = await prisma.inventoryStock.findFirst({
    where: { itemId: items[2].id, branchId: kandy.id },
  })
  const atMain = await prisma.inventoryStock.findFirst({
    where: { itemId: items[2].id, branchId: main.id },
  })
  check('30 landed at Kandy, where the van actually went', atKandy?.available === 30, `${atKandy?.available}`)
  check('and 70 at Main, where the first delivery went', atMain?.available === 70, `${atMain?.available}`)

  const gone = await listAwaitingDelivery({ restaurantId: restaurant.id })
  check(
    'a fully received order leaves the receiving screen',
    !gone.some((row) => row.id === po.id),
    'it would sit there for ever with nothing to receive',
  )

  console.log('\n── the goods receipt stands on its own ──')

  const receipt = await getReceiptDetail({
    restaurantId: restaurant.id,
    receiptId: second.receipt.id,
    currency: 'LKR',
  })
  check('the receipt is readable', Boolean(receipt))
  check('it knows its order', receipt?.purchaseNumber === po.number, `${receipt?.purchaseNumber}`)
  check('and its supplier', receipt?.supplierName === 'ABC Distributors')
  check('and where it landed', receipt?.branchName === 'Kandy', `${receipt?.branchName}`)
  check(
    'it shows ordered against accepted',
    receipt?.lines[0]?.orderedQty === 100 && receipt?.lines[0]?.acceptedQty === 30,
    `${receipt?.lines[0]?.orderedQty} / ${receipt?.lines[0]?.acceptedQty}`,
  )
  check(
    'and what was actually charged, not what was ordered',
    receipt?.lines[0]?.unitCost === 20_000 && receipt?.lines[0]?.orderedUnitCost === 18_000,
    `${receipt?.lines[0]?.unitCost} vs ${receipt?.lines[0]?.orderedUnitCost}`,
  )
  check('with the value of the delivery', receipt?.acceptedTotal === 30 * 20_000, `${receipt?.acceptedTotal}`)

  console.log('\n── last purchased price ──')

  const builder = await getPoBuilderData({ restaurantId: restaurant.id, currency: 'LKR' })
  const bought = builder.items.find((i) => i.id === items[2].id)
  const neverBought = builder.items.find((i) => i.id === items[5].id)

  check('an item with history reports its last price', bought?.lastPurchase !== null)
  check(
    'and it is what was last PAID, not what was ordered',
    bought?.lastPurchase?.unitCost === 20_000,
    `${bought?.lastPurchase?.unitCost}`,
  )
  check('with the supplier', bought?.lastPurchase?.supplierName === 'ABC Distributors')
  check(
    'while an item never bought says so',
    neverBought?.lastPurchase === null,
    'it would show a price out of nowhere',
  )

  console.log('\n── search finds an order by every name it has ──')

  for (const [label, term] of [
    ['its own number', po.number],
    ['the supplier', 'abc distrib'],
    ['an item on it', 'Item 3'],
    ['the GRN number', first.receipt.number],
    ['the supplier’s invoice', 'INV-9001'],
  ] as const) {
    const hits = await listPurchaseOrders({ restaurantId: restaurant.id, search: term })
    check(`by ${label}`, hits.some((row) => row.id === po.id), `“${term}” found nothing`)
  }

  const nonsense = await listPurchaseOrders({ restaurantId: restaurant.id, search: 'zzzzzz' })
  check('and a term that matches nothing returns nothing', nonsense.length === 0, `${nonsense.length}`)

  const blank = await listPurchaseOrders({ restaurantId: restaurant.id, search: '   ' })
  check(
    'while a blank search returns everything, not nothing',
    blank.length > 0,
    'clearing the box emptied the page',
  )

  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: restaurant.id } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchasePriceHistory.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: restaurant.id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: restaurant.id } })
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
