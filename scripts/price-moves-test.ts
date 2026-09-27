/**
 * `listPriceMoves` — the prices a branch actually paid, and only that branch's.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The Purchasing report used to narrow its price history with
 * `where: { purchase: { branchId } }`. `PurchasePriceHistory` has no `purchase`
 * relation — it holds `itemId`, `supplierId` and a bare `receiptId` column —
 * so Prisma rejected the unknown argument before reading a row. The report
 * threw for every tenant that picked a location, on an empty table, every
 * time; there were 89 of them in `error_logs` before anyone noticed, because
 * the page still answered 200 and the failure only appeared once the browser
 * ran the stream (see `scripts/streamed-error.ts`).
 *
 * `report-filter-test` pins that the page no longer throws. That is not the
 * same as pinning that it filters, and an empty table cannot tell the two
 * apart: a branch filter that silently returns nothing looks identical to a
 * correct one until somebody has data. So this gives it data — two branches,
 * two deliveries of one item at two different prices — and asserts the
 * arithmetic that the report draws its trend from.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/price-moves-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { listPriceMoves } from '../src/features/purchasing/queries'

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  const stamp = Math.random().toString(36).slice(2, 10)
  const shop = await prisma.restaurant.create({
    data: { name: `Price ${stamp}`, slug: `price-${stamp}`, status: 'ACTIVE', isActive: true },
  })

  try {
    const kandy = await prisma.branch.create({
      data: { restaurantId: shop.id, name: 'Kandy', code: `K${stamp.slice(0, 4)}` },
    })
    const jaffna = await prisma.branch.create({
      data: { restaurantId: shop.id, name: 'Jaffna', code: `J${stamp.slice(0, 4)}` },
    })
    const supplier = await prisma.supplier.create({
      data: { restaurantId: shop.id, name: 'Wholesale Co' },
    })
    const item = await prisma.inventoryItem.create({
      data: { restaurantId: shop.id, name: `Chicken ${stamp}` },
    })

    /** One delivery at one branch, recording one price. */
    const deliver = async (branchId: string, unitCost: number, at: Date) => {
      const purchase = await prisma.purchase.create({
        data: { restaurantId: shop.id, branchId, number: `PO-${stamp}-${unitCost}` },
      })
      const receipt = await prisma.goodsReceipt.create({
        data: {
          restaurantId: shop.id,
          purchaseId: purchase.id,
          branchId,
          number: `GRN-${stamp}-${unitCost}`,
        },
      })
      return prisma.purchasePriceHistory.create({
        data: {
          restaurantId: shop.id,
          itemId: item.id,
          supplierId: supplier.id,
          unitCost,
          quantity: 10,
          receiptId: receipt.id,
          recordedAt: at,
        },
      })
    }

    const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12))
    await deliver(kandy.id, 50_000, day(2)) // Kandy bought cheap, then dear
    await deliver(kandy.id, 70_000, day(6))
    await deliver(jaffna.id, 90_000, day(4)) // Jaffna bought dear once

    const whole = { restaurantId: shop.id, from: day(1), to: day(9) }

    console.log('\n── 1. Unfiltered: every branch, oldest first ──')
    const all = await listPriceMoves(whole)
    check('all three deliveries are there', all.length === 3, `${all.length}`)
    check(
      'ordered oldest first',
      all.map((row) => row.unitCost).join(',') === '50000,90000,70000',
      all.map((row) => row.unitCost).join(','),
    )
    check('the item is named for the report', all[0]?.item?.name === item.name)
    check('so is the supplier', all[0]?.supplier?.name === 'Wholesale Co')

    console.log('\n── 2. Narrowed to one branch ──')
    const atKandy = await listPriceMoves({ ...whole, branchId: kandy.id })
    check('only Kandy\'s two deliveries', atKandy.length === 2, `${atKandy.length}`)
    check(
      'and they are Kandy\'s prices, not Jaffna\'s',
      atKandy.map((row) => row.unitCost).join(',') === '50000,70000',
      atKandy.map((row) => row.unitCost).join(','),
    )
    /*
     * The figure the report actually prints. Kandy went 50,000 → 70,000, a
     * 40% rise. Unfiltered, the last row is Kandy's 70,000 and the first is
     * Kandy's 50,000 too, so the percentage is only right by accident there —
     * which is exactly why the branch filter has to work rather than merely
     * not throw.
     */
    const first = atKandy[0].unitCost
    const latest = atKandy[atKandy.length - 1].unitCost
    check('the trend the report draws is +40%', Math.round(((latest - first) / first) * 100) === 40)

    const atJaffna = await listPriceMoves({ ...whole, branchId: jaffna.id })
    check('Jaffna sees only its own delivery', atJaffna.length === 1, `${atJaffna.length}`)
    check('at its own price', atJaffna[0]?.unitCost === 90_000)

    console.log('\n── 3. The period still applies once a branch is chosen ──')
    const early = await listPriceMoves({ ...whole, to: day(3), branchId: kandy.id })
    check('a window before the second delivery holds one row', early.length === 1, `${early.length}`)
    check('the first one', early[0]?.unitCost === 50_000)
    const none = await listPriceMoves({ restaurantId: shop.id, from: day(7), to: day(9), branchId: kandy.id })
    check('a window after them holds none', none.length === 0, `${none.length}`)

    console.log('\n── 4. A branch that is not this tenant\'s buys nothing ──')
    const stranger = await prisma.branch.findFirst({
      where: { restaurantId: { not: shop.id }, deletedAt: null },
      select: { id: true },
    })
    if (stranger) {
      const leaked = await listPriceMoves({ ...whole, branchId: stranger.id })
      check('another tenant\'s branch id returns nothing, not everything', leaked.length === 0, `${leaked.length}`)
    } else {
      console.log('  · no other tenant in this database — cross-tenant case not exercised')
    }
    const missing = await listPriceMoves({ ...whole, branchId: 'does-not-exist' })
    check('an unknown branch id returns nothing, not everything', missing.length === 0, `${missing.length}`)
  } finally {
    await prisma.purchasePriceHistory.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.goodsReceipt.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.purchase.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.supplier.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.restaurant.deleteMany({ where: { id: shop.id } })
    await prisma.$disconnect()
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
