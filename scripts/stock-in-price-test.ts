/**
 * Stock in at a new price, and what FIFO does with it.
 *
 * ── The thing this proves ───────────────────────────────────────────────────
 *
 * An owner buys the same item again at a higher price. They cannot record that
 * as a second item — the name is taken, and rightly so, because a price
 * belongs to a delivery rather than to an item. So the price goes on the way
 * in, and the ledger keeps the two deliveries apart:
 *
 *   the older stock keeps costing what it cost
 *   the new price is invisible until that runs out
 *   then it takes over, and the next sale costs what the new stock cost
 *
 * Before the `unitCost` field existed, an inbound adjustment was valued at the
 * item's CURRENT cost, so the second delivery silently joined the first at the
 * old price and a price rise never reached the books at all. Section 2 is what
 * fails if that regresses.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/stock-in-price-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { adjustStock } from '../src/features/inventory/operations'
import { allocateAndConsume, currentUnitCost } from '../src/features/inventory/fifo'
import { postMovement } from '../src/features/inventory/ledger'

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

const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance

async function main() {
  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: { name: `Stock price ${stamp}`, slug: `stock-price-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `keeper-${stamp}@test.dev`, name: 'Keeper',
      role: 'OWNER', passwordHash: 'x',
    },
  })
  /* Base unit KG, so a price typed per kilo needs no conversion and the
   * arithmetic below stays readable. Unit conversion is proved elsewhere. */
  const rice = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 0, costPerUnit: 0 },
  })

  const stockIn = (quantity: number, totalValue?: number) =>
    adjustStock({
      restaurantId: restaurant.id,
      branchId: branch.id,
      itemId: rice.id,
      quantity,
      direction: 'IN',
      reason: 'Test delivery',
      userId: user.id,
      totalValue,
    })

  try {
    console.log('\n1. First delivery: 10 kg at 500')
    {
      /* 500.00 a kilo, in minor units, over 10 kg. */
      await stockIn(10, 500_00 * 10)
      const rate = await currentUnitCost(prisma, {
        restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id,
      })
      check('the next kilo costs 500', near(rate, 500_00), `got ${rate}`)

      const layers = await prisma.stockBatch.findMany({
        where: { restaurantId: restaurant.id, itemId: rice.id },
      })
      check('one layer exists', layers.length === 1)
    }

    console.log('\n2. Second delivery at a NEW price: 10 kg at 800')
    {
      await stockIn(10, 800_00 * 10)

      const layers = await prisma.stockBatch.findMany({
        where: { restaurantId: restaurant.id, itemId: rice.id },
        orderBy: { receivedAt: 'asc' },
      })
      check('it made a SECOND layer, not one merged blob', layers.length === 2)

      /*
       * The heart of it. The new price must NOT change what the old stock is
       * worth, and must NOT show up as the next cost while old stock remains.
       * A weighted average would report 650 here, which is the behaviour this
       * whole feature exists to avoid.
       */
      const rate = await currentUnitCost(prisma, {
        restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id,
      })
      check('the next kilo STILL costs 500, not 800', near(rate, 500_00), `got ${rate}`)
      check('and not the 650 average either', !near(rate, 650_00, 50))
    }

    console.log('\n3. Using the old stock up')
    {
      /* 8 of the first 10 kg. */
      const drawn = await prisma.$transaction((tx) =>
        allocateAndConsume(tx, {
          restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id, quantity: 8,
        }),
      )
      check('8 kg costs 8 × 500', near(drawn.totalValue, 500_00 * 8), `got ${drawn.totalValue}`)

      const rate = await currentUnitCost(prisma, {
        restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id,
      })
      check('with 2 kg of old stock left, the rate is still 500', near(rate, 500_00), `got ${rate}`)
    }

    console.log('\n4. The old stock runs out — the new price appears')
    {
      /* 4 kg: the last 2 old at 500, then 2 new at 800. */
      const drawn = await prisma.$transaction((tx) =>
        allocateAndConsume(tx, {
          restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id, quantity: 4,
        }),
      )
      check(
        'it crosses the boundary — 2 at 500 plus 2 at 800',
        near(drawn.totalValue, 500_00 * 2 + 800_00 * 2),
        `got ${drawn.totalValue}`,
      )

      const rate = await currentUnitCost(prisma, {
        restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id,
      })
      check('now the next kilo costs 800', near(rate, 800_00), `got ${rate}`)
    }

    console.log('\n5. Stock in with NO price still works')
    {
      /* The ordinary correction-to-a-count case: no price typed, so it is
       * valued at what the item currently costs rather than refused. */
      const before = await prisma.inventoryItem.findUniqueOrThrow({
        where: { id: rice.id }, select: { quantity: true },
      })
      const posted = await stockIn(5)
      check('the balance still moves', near(posted.balanceAfter, before.quantity + 5, 0.001))

      const layers = await prisma.stockBatch.count({
        where: { restaurantId: restaurant.id, itemId: rice.id },
      })
      check('and it still makes its own layer', layers === 3)
    }
    console.log('\n6. The Stock in/out dialog\u2019s own path (type = PURCHASE)')
    {
      /*
       * What `recordStockMovement` does when somebody picks "Stock in
       * (purchase)" and types a price. Adjustments post ADJUSTMENT_IN; this
       * posts PURCHASE, and the price has to reach the layer on both routes or
       * the field works on one screen and silently does nothing on the other.
       */
      const before = await currentUnitCost(prisma, {
        restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id,
      })

      await prisma.$transaction((tx) =>
        postMovement(tx, {
          restaurantId: restaurant.id,
          itemId: rice.id,
          branchId: branch.id,
          userId: user.id,
          type: 'PURCHASE',
          quantity: 5,
          totalValue: 1_500_00 * 5,
        } as never),
      )

      const layers = await prisma.stockBatch.findMany({
        where: { restaurantId: restaurant.id, itemId: rice.id, remainingQty: { gt: 0 } },
        orderBy: { receivedAt: 'asc' },
      })
      const newest = layers[layers.length - 1]
      check(
        'a purchase at 1,500 makes its own layer at 1,500',
        newest !== undefined && near(newest.unitCost, 1_500_00),
        newest ? String(newest.unitCost) : 'no layer',
      )

      const after = await currentUnitCost(prisma, {
        restaurantId: restaurant.id, itemId: rice.id, branchId: branch.id,
      })
      check('and the older stock still prices the next unit', near(after, before), `${before} -> ${after}`)
    }

  } finally {
    /* Cascades from the restaurant, so one delete clears the lot. */
    await prisma.restaurant.delete({ where: { id: restaurant.id } }).catch(() => {})
    await prisma.$disconnect()
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
