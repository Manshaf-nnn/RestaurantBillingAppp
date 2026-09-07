/**
 * Repair stock balances that no movement can explain.
 *
 * Two integrity checks fail on drift that ordinary use cannot fix:
 *
 *   stock-replay      item.quantity ≠ Σ its stock movements
 *   branch-stock-sum  item.quantity ≠ Σ its per-branch rows
 *
 * Every legitimate operation changes the balance and writes its movement in
 * the same transaction, so the gap between them never closes by working
 * normally — a stock count posts an adjustment to BOTH sides and leaves the
 * drift exactly where it was. The gap is always historical: a balance typed
 * in before the code wrote an opening movement for it.
 *
 * The honest repair is therefore to write the history that was missed, not to
 * move the stock: an OPENING_BALANCE movement for the unexplained quantity,
 * dated when the item was created, saying so in its reason. The balance on
 * the shelf does not move — it was never wrong, it was just unexplained.
 *
 * Prints a plan and changes nothing unless you pass --apply.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/repair-stock-drift.ts
 *   npx tsx --tsconfig tsconfig.test.json scripts/repair-stock-drift.ts --apply
 */
import { prisma } from '../src/server/db/prisma'

const APPLY = process.argv.includes('--apply')

interface Drift {
  id: string
  name: string
  unit: string
  quantity: number
  ledger: number
  branches: number
  hasBranchRows: boolean
  branchId: string | null
  createdAt: Date
}

async function findDrift(restaurantId?: string): Promise<Drift[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string
      name: string
      unit: string
      quantity: number
      ledger: number | null
      branches: number | null
      branchrows: bigint
      branchid: string | null
      createdat: Date
    }>
  >`
    SELECT i.id, i.name, i.unit, i.quantity,
      (SELECT SUM(m.quantity) FROM stock_movements m WHERE m."itemId" = i.id) AS ledger,
      (SELECT SUM(s.available) FROM inventory_stock s WHERE s."itemId" = i.id) AS branches,
      (SELECT COUNT(*) FROM inventory_stock s WHERE s."itemId" = i.id) AS branchrows,
      (SELECT s."branchId" FROM inventory_stock s WHERE s."itemId" = i.id
        ORDER BY s.available DESC LIMIT 1) AS branchid,
      i."createdAt" AS createdat
    FROM inventory_items i
    WHERE (${restaurantId ?? null}::text IS NULL OR i."restaurantId" = ${restaurantId ?? null})
  `
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      unit: row.unit,
      quantity: Number(row.quantity),
      ledger: Number(row.ledger ?? 0),
      branches: Number(row.branches ?? 0),
      hasBranchRows: Number(row.branchrows) > 0,
      branchId: row.branchid,
      createdAt: row.createdat,
    }))
    .filter(
      (row) =>
        Math.abs(row.quantity - row.ledger) > 1e-6 ||
        (row.hasBranchRows && Math.abs(row.quantity - row.branches) > 1e-6),
    )
}

async function main() {
  const drift = await findDrift(process.env.RESTAURANT_ID)

  if (drift.length === 0) {
    console.log('\nNo unexplained stock balances. Nothing to repair.\n')
    process.exit(0)
  }

  console.log(`\n${drift.length} item(s) whose balance the ledger cannot explain:\n`)
  for (const item of drift) {
    const ledgerGap = Math.round((item.quantity - item.ledger) * 1e6) / 1e6
    const branchGap = Math.round((item.quantity - item.branches) * 1e6) / 1e6
    console.log(`  ${item.name} (${item.unit})`)
    console.log(`    on hand ${item.quantity} · ledger explains ${item.ledger}${ledgerGap ? `  → ${ledgerGap > 0 ? '+' : ''}${ledgerGap} unexplained` : '  ✓'}`)
    if (item.hasBranchRows) {
      console.log(`    shelves hold ${item.branches}${branchGap ? `  → ${branchGap > 0 ? '+' : ''}${branchGap} not on any shelf` : '  ✓'}`)
    }
  }

  if (!APPLY) {
    console.log('\nDry run. Nothing was changed — pass --apply to write the repair.\n')
    console.log('It will, for each item above:')
    console.log('  • post an OPENING_BALANCE movement for the unexplained quantity,')
    console.log('    dated when the item was created, so the ledger adds up;')
    console.log('  • put any stock that is on no shelf onto the item’s main branch.')
    console.log('  The quantity on hand does not change. Nothing is invented: the')
    console.log('  stock was already there, it just had no history behind it.\n')
    process.exit(0)
  }

  for (const item of drift) {
    await prisma.$transaction(async (tx) => {
      const owner = await tx.inventoryItem.findUniqueOrThrow({
        where: { id: item.id }, select: { restaurantId: true },
      })
      // A movement names a branch. The item's own shelf where it has one,
      // otherwise the restaurant's default site.
      const branch =
        item.branchId ??
        (await tx.branch.findFirst({
          where: { restaurantId: owner.restaurantId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { id: true },
        }))?.id

      const ledgerGap = item.quantity - item.ledger
      if (Math.abs(ledgerGap) > 1e-6 && branch) {
        /*
         * Written straight to the ledger, deliberately: `postMovement` would
         * ALSO move the balance, and the balance is the half that is already
         * right. This row explains stock that is on the shelf, it does not
         * add any.
         */
        await tx.stockMovement.create({
          data: {
            restaurant: { connect: { id: owner.restaurantId } },
            item: { connect: { id: item.id } },
            branch: { connect: { id: branch } },
            type: 'OPENING_BALANCE',
            quantity: ledgerGap,
            unitCost: 0,
            reason: 'Opening balance, recorded late — stock counted in before the ledger kept it',
            createdAt: item.createdAt,
          },
        })
      }

      const branchGap = item.quantity - item.branches
      if (item.hasBranchRows && Math.abs(branchGap) > 1e-6 && item.branchId) {
        await tx.inventoryStock.updateMany({
          where: { itemId: item.id, branchId: item.branchId },
          data: { available: { increment: branchGap } },
        })
      }
    })
    console.log(`  ✓ repaired ${item.name}`)
  }

  const left = await findDrift(process.env.RESTAURANT_ID)
  console.log(
    left.length === 0
      ? '\nEvery balance is explained by its ledger now.\n'
      : `\n${left.length} item(s) still drifting — look at them by hand.\n`,
  )
  process.exit(left.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
