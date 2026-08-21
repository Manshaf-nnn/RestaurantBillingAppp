/**
 * Repair per-branch stock after the missing-branch bug.
 *
 * Sale postings used to carry no branch, so `applyLocationDelta` skipped them
 * and `InventoryStock.available` only ever went up. Fixing the code stops the
 * drift; it does not undo it. Existing branch balances still overstate what is
 * on the shelf by everything ever sold there, and `assertSufficient` reads those
 * numbers — so transfers are being approved against stock that was eaten weeks
 * ago.
 *
 * Two steps, in order:
 *
 *   1. Backfill `StockMovement.branchId` for order-linked movements that have
 *      none, from the order's own branch (falling back to the restaurant's
 *      default). Without this the ledger cannot say where the stock went.
 *   2. Rebuild `InventoryStock.available` as the sum of the movements for each
 *      (item, branch, shelf).
 *
 * `reserved` and `inTransit` are left alone: those are maintained by the
 * transfer workflow and are not derivable from the movement ledger.
 *
 * DRY RUN BY DEFAULT — it prints what it would change and writes nothing.
 * Re-run with --apply once the numbers look right.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/repair-branch-stock.ts
 *   npx tsx --tsconfig tsconfig.test.json scripts/repair-branch-stock.ts --apply
 */
import { prisma } from '../src/server/db/prisma'

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(APPLY ? '── APPLYING CHANGES ──\n' : '── dry run: nothing will be written ──\n')

  // ── 1. movements that know their order but not their branch ────────────────
  const orphans = await prisma.stockMovement.findMany({
    where: { branchId: null, orderId: { not: null } },
    select: { id: true, restaurantId: true, orderId: true },
  })

  const branchForOrder = new Map<string, string | null>()
  const defaultBranch = new Map<string, string | null>()
  let attributed = 0
  let unattributable = 0

  for (const movement of orphans) {
    const orderId = movement.orderId!
    if (!branchForOrder.has(orderId)) {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { branchId: true },
      })
      branchForOrder.set(orderId, order?.branchId ?? null)
    }
    let branchId = branchForOrder.get(orderId) ?? null

    // A single-location restaurant leaves Order.branchId null; its stock still
    // lives at the default branch.
    if (!branchId) {
      if (!defaultBranch.has(movement.restaurantId)) {
        const fallback = await prisma.branch.findFirst({
          where: { restaurantId: movement.restaurantId, deletedAt: null, isDefault: true },
          select: { id: true },
        })
        defaultBranch.set(movement.restaurantId, fallback?.id ?? null)
      }
      branchId = defaultBranch.get(movement.restaurantId) ?? null
    }

    if (!branchId) {
      unattributable += 1
      continue
    }
    if (APPLY) {
      await prisma.stockMovement.update({ where: { id: movement.id }, data: { branchId } })
    }
    attributed += 1
  }

  console.log(`movements missing a branch:      ${orphans.length}`)
  console.log(`  attributable to a branch:      ${attributed}`)
  console.log(`  no branch could be resolved:   ${unattributable}`)

  const stillNull = await prisma.stockMovement.count({ where: { branchId: null } })
  console.log(`movements with no branch at all: ${stillNull} (opening balances and manual posts predating branches)\n`)

  // ── 2. rebuild available from the ledger ───────────────────────────────────
  const grouped = await prisma.stockMovement.groupBy({
    by: ['restaurantId', 'itemId', 'branchId', 'locationId'],
    where: { branchId: { not: null } },
    _sum: { quantity: true },
  })

  let changed = 0
  let matched = 0
  const samples: string[] = []

  for (const row of grouped) {
    const ledger = Math.round((row._sum.quantity ?? 0) * 1e6) / 1e6

    const existing = await prisma.inventoryStock.findFirst({
      where: {
        restaurantId: row.restaurantId,
        itemId: row.itemId,
        branchId: row.branchId!,
        storageLocationId: row.locationId,
      },
    })

    if (existing && Math.abs(existing.available - ledger) < 1e-6) {
      matched += 1
      continue
    }
    changed += 1
    if (samples.length < 12) {
      const item = await prisma.inventoryItem.findUnique({
        where: { id: row.itemId },
        select: { name: true },
      })
      samples.push(
        `    ${(item?.name ?? row.itemId).padEnd(24)} ${String(existing?.available ?? 0).padStart(10)} → ${String(ledger).padStart(10)}`,
      )
    }

    if (!APPLY) continue

    if (existing) {
      await prisma.inventoryStock.update({ where: { id: existing.id }, data: { available: ledger } })
    } else {
      await prisma.inventoryStock.create({
        data: {
          restaurantId: row.restaurantId,
          itemId: row.itemId,
          branchId: row.branchId!,
          storageLocationId: row.locationId,
          available: ledger,
        },
      })
    }
  }

  console.log(`branch/shelf balances checked:   ${grouped.length}`)
  console.log(`  already correct:               ${matched}`)
  console.log(`  ${APPLY ? 'corrected' : 'would correct'}:${' '.repeat(APPLY ? 21 : 17)}${changed}`)
  if (samples.length > 0) {
    console.log('\n  sample corrections (cached → ledger):')
    console.log(samples.join('\n'))
  }

  console.log(
    APPLY
      ? '\n✓ done. Re-run without --apply to confirm everything now matches.'
      : '\nNothing was written. Re-run with --apply to make these changes.',
  )
  await prisma.$disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
