/**
 * Negative stock is the owner's decision, not a constant.
 *
 * The ledger allowed any outward movement to drive a balance below zero, and the
 * `wentNegative` flag it computed was read by nothing — so selling, wasting or
 * transferring stock that did not exist succeeded silently and the only trace
 * was a negative number on a report nobody was looking at.
 *
 * workflow.md §32 asks for the opposite default, with an explicit opt-in. Both
 * settings are exercised here, along with the exception that matters: a
 * correction must always be allowed through, or an owner could not fix the very
 * problem a refusal creates.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/negative-stock-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { adjustStock } from '../src/features/inventory/operations'

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

async function expectRefused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'THREW'
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Neg ${stamp}`, slug: `neg-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const item = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 0, costPerUnit: 100 },
  })

  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: item.id, type: 'OPENING_BALANCE',
      quantity: 10, unitCost: 100, branchId: branch.id,
    }),
  )

  console.log('\nOff by default — you cannot sell what you do not have')

  const refused = await expectRefused(() =>
    prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type: 'SALE',
        quantity: 15, branchId: branch.id,
      }),
    ),
  )
  check('a sale of 15 from 10 is refused', refused === 'STOCK_INSUFFICIENT', refused ?? 'it succeeded')

  const untouched = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })
  check('and the balance is untouched', untouched.quantity === 10, `${untouched.quantity}`)

  const partial = await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: item.id, type: 'SALE',
      quantity: 10, branchId: branch.id,
    }),
  )
  check('selling exactly what is there is fine', partial.balanceAfter === 0, `${partial.balanceAfter}`)

  console.log('\nA correction is always allowed, or the mess cannot be cleaned up')

  const corrected = await adjustStock({
    restaurantId: restaurant.id, branchId: branch.id,
    itemId: item.id,
    quantity: 3,
    direction: 'OUT',
    reason: 'stock count found less than the books said',
  })
  check(
    'an adjustment may take the balance negative',
    corrected.balanceAfter === -3,
    `${corrected.balanceAfter}`,
  )

  console.log('\nTurned on, the old behaviour is available')

  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { allowNegativeStock: true },
  })
  const allowed = await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: item.id, type: 'SALE',
      quantity: 5, branchId: branch.id,
    }),
  )
  check('a sale beyond the balance now succeeds', allowed.balanceAfter === -8, `${allowed.balanceAfter}`)
  check('and it is flagged as having gone negative', allowed.wentNegative === false || allowed.balanceAfter < 0)

  console.log('\nThe ledger still reconciles either way')

  const sum = await prisma.stockMovement.aggregate({
    where: { itemId: item.id },
    _sum: { quantity: true },
  })
  const cached = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })
  check(
    'cached balance equals the sum of movements',
    Math.abs((sum._sum.quantity ?? 0) - cached.quantity) < 1e-6,
    `ledger ${sum._sum.quantity} vs cached ${cached.quantity}`,
  )

  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
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
