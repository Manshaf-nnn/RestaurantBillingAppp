/**
 * Goods go back off the delivery that brought them (FIFO.md).
 *
 * ── Why a return is not an ordinary issue ──────────────────────────────────
 *
 * Every other outbound movement is stock being used, and oldest-first is the
 * right answer for all of them. A return to supplier is the undoing of one
 * receipt, and the goods on the lorry are the ones that came off it — so they
 * must leave at what that delivery charged, which is what the supplier is
 * about to credit.
 *
 * Draw the oldest layer instead and the two legs disagree. Return 5 kg from a
 * 20.00/kg delivery while an older 10.00/kg layer is still open: inventory
 * falls 50.00 against a 100.00 credit, and the books show a 50.00 profit on
 * having sent goods back. It is not a rounding artefact — it is the whole
 * price difference, on every return, in the direction that flatters the
 * accounts. A restaurant with rising prices would book a gain each time it
 * rejected a delivery.
 *
 * What this pins:
 *
 *   • a return against a purchase draws THAT purchase's layers, whatever the
 *     FIFO queue would otherwise have offered;
 *   • the older, cheaper layer is left completely untouched;
 *   • what leaves inventory equals what the supplier credits, so the entry
 *     nets to zero and account 1200 still ties to the layers;
 *   • a return naming no purchase falls back to ordinary oldest-first;
 *   • a return for more than that delivery still holds takes the remainder
 *     from the queue rather than failing or inventing a layer;
 *   • the lot trace names the layers that were actually drawn.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/fifo-returns-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { createPurchaseReturn, receiveGoods } from '../src/features/purchasing/receiving'

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
  const M = (major: number) => Math.round(major * 100)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Ret ${stamp}`, slug: `ret-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `buy-${stamp}@test.dev`, name: 'Nimal',
      role: 'OWNER', passwordHash: 'x',
    },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Mill ${stamp}` },
  })
  const rice = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 0, costPerUnit: 0 },
  })

  const layers = () =>
    prisma.stockBatch.findMany({
      where: { itemId: rice.id, branchId: branch.id, remainingQty: { gt: 0 } },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, batchNo: true, remainingQty: true, remainingValue: true },
    })
  const value = async () =>
    (await prisma.stockBatch.aggregate({
      where: { itemId: rice.id, branchId: branch.id, remainingQty: { gt: 0 } },
      _sum: { remainingValue: true },
    }))._sum.remainingValue ?? 0

  /*
   * An old, cheap delivery already on the shelf — this is the layer FIFO would
   * reach for, and the one a correct return must leave alone.
   */
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id, userId: user.id,
    type: 'PURCHASE', quantity: 40, unitCost: M(10), totalValue: 40 * M(10),
    batchNo: `OLD-${stamp}`, receivedAt: new Date(Date.UTC(2026, 0, 1)),
  }))

  /** A delivery through the real purchasing services, at a dearer price. */
  async function deliver(quantity: number, unitCost: number) {
    const po = await createPurchaseOrder({
      restaurantId: restaurant.id, supplierId: supplier.id, branchId: branch.id,
      lines: [{ itemId: rice.id, quantity, unitCost }], userId: user.id,
    })
    await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: po.id, status: 'APPROVED', userId: user.id })
    await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: po.id, status: 'ORDERED', userId: user.id })
    const lines = await prisma.purchaseItem.findMany({ where: { purchaseId: po.id } })
    await receiveGoods({
      restaurantId: restaurant.id, purchaseId: po.id,
      lines: [{ purchaseItemId: lines[0].id, acceptedQty: quantity }], userId: user.id,
    })
    return po
  }

  const dear = await deliver(20, M(20))

  console.log('\n── 1. Two layers, two prices ──')
  {
    const open = await layers()
    check('the old cheap layer is still first in the queue',
      open.length === 2 && open[0].remainingValue === 40 * M(10), JSON.stringify(open))
    check('the new delivery is a layer of its own at its own price',
      open[1]?.remainingQty === 20 && open[1]?.remainingValue === 20 * M(20),
      JSON.stringify(open[1]))
    check('the shelf is worth both together', (await value()) === 40 * M(10) + 20 * M(20))
  }

  console.log('\n── 2. A return draws the delivery it names, not the oldest ──')
  {
    const before = await value()
    const ret = await createPurchaseReturn({
      restaurantId: restaurant.id, branchId: branch.id, supplierId: supplier.id,
      purchaseId: dear.id, reason: 'Wet sacks', userId: user.id,
      lines: [{ itemId: rice.id, quantity: 5, unitCost: M(20) }],
    })

    const open = await layers()
    const oldLayer = open.find((l) => l.batchNo.startsWith('OLD-'))
    check('the old 10.00 layer was not touched at all',
      oldLayer?.remainingQty === 40 && oldLayer?.remainingValue === 40 * M(10),
      JSON.stringify(oldLayer))

    const newLayer = open.find((l) => !l.batchNo.startsWith('OLD-'))
    check('the returned goods came off the delivery that brought them',
      newLayer?.remainingQty === 15 && newLayer?.remainingValue === 15 * M(20),
      JSON.stringify(newLayer))

    /*
     * The figure that matters. 5 kg at the delivery's 20.00 is 100.00, which is
     * exactly what the supplier credits. Oldest-first would have taken 50.00
     * and booked the other 50.00 as profit.
     */
    const left = await value()
    check('inventory fell by what the supplier credits, to the minor unit',
      before - left === 5 * M(20), `${before - left} vs ${5 * M(20)}`)

    const moved = await prisma.stockMovement.findFirst({
      where: { restaurantId: restaurant.id, referenceType: 'PurchaseReturn', referenceId: ret.id },
      select: { valueMoved: true, lots: { select: { batchNo: true, quantity: true, lineValue: true } } },
    })
    check('the movement records that exact value', moved?.valueMoved === 5 * M(20), String(moved?.valueMoved))
    check('the trace names one layer — the delivery’s own',
      moved?.lots.length === 1 && !moved.lots[0].batchNo?.startsWith('OLD-'),
      JSON.stringify(moved?.lots))
  }

  console.log('\n── 3. More than that delivery held falls through to FIFO ──')
  {
    const before = await value()
    // 15 kg left on the dear layer; asking for 20 takes all of it and then 5
    // from the old layer, which is the only stock there is.
    await createPurchaseReturn({
      restaurantId: restaurant.id, branchId: branch.id, supplierId: supplier.id,
      purchaseId: dear.id, reason: 'Whole consignment rejected', userId: user.id,
      lines: [{ itemId: rice.id, quantity: 20, unitCost: M(20) }],
    })

    const open = await layers()
    check('the delivery’s layer is gone, not left holding a scrap of value',
      open.every((layer) => layer.batchNo.startsWith('OLD-')), JSON.stringify(open))
    check('the remainder came out of the old layer',
      open.length === 1 && open[0].remainingQty === 35, JSON.stringify(open))

    // 15 kg at the delivery's 20.00, then 5 kg at the old layer's 10.00. The
    // shortfall is priced where it actually came from, not at the return note.
    const fell = before - (await value())
    const expected = 15 * M(20) + 5 * M(10)
    check('and the overflow left at ITS price, not the returned delivery’s',
      fell === expected, `${fell} vs ${expected}`)
  }

  console.log('\n── 4. A return naming no purchase is an ordinary FIFO draw ──')
  {
    const before = await value()
    await createPurchaseReturn({
      restaurantId: restaurant.id, branchId: branch.id, supplierId: supplier.id,
      reason: 'Found spoiled, no paperwork', userId: user.id,
      lines: [{ itemId: rice.id, quantity: 5, unitCost: M(10) }],
    })
    const fell = before - (await value())
    check('oldest first, at the oldest layer’s price',
      fell === 5 * M(10), `${fell} vs ${5 * M(10)}`)
  }

  console.log('\n── 5. Nothing was created or destroyed ──')
  {
    const received = await prisma.stockMovement.aggregate({
      where: { restaurantId: restaurant.id, itemId: rice.id, quantity: { gt: 0 } },
      _sum: { valueMoved: true },
    })
    const returned = await prisma.stockMovement.aggregate({
      where: { restaurantId: restaurant.id, itemId: rice.id, quantity: { lt: 0 } },
      _sum: { valueMoved: true },
    })
    const expected = (received._sum.valueMoved ?? 0) - (returned._sum.valueMoved ?? 0)
    check('what is on the shelf = everything in − everything out',
      (await value()) === expected, `${await value()} vs ${expected}`)

    const negative = await prisma.stockBatch.count({
      where: { restaurantId: restaurant.id, OR: [{ remainingQty: { lt: 0 } }, { remainingValue: { lt: 0 } }] },
    })
    check('no layer went negative', negative === 0, String(negative))
  }

  /* ── Clean up ────────────────────────────────────────────────────────────── */
  await prisma.stockMovementLot.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchaseReturnLine.deleteMany({ where: { return: { restaurantId: restaurant.id } } })
  await prisma.purchaseReturn.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchasePriceHistory.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: restaurant.id } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: restaurant.id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
