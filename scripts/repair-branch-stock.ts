/**
 * Repair per-branch stock, and check the branch back-fill landed sensibly.
 *
 * Sale postings used to carry no branch, so `applyLocationDelta` skipped them
 * and `InventoryStock.available` only ever went up. Fixing the code stops the
 * drift; it does not undo it. Existing branch balances still overstate what is
 * on the shelf by everything ever sold there, and `assertSufficient` reads those
 * numbers — so transfers were being approved against stock eaten weeks ago.
 *
 * ── What changed, and what this script still does ───────────────────────────
 *
 * Step 1 used to be here: attribute branch-less movements to their order's
 * branch. It has moved into 20260903090000_branch_isolation_2, which back-fills
 * every operational table and then makes the column NOT NULL — so a movement
 * with no location can no longer exist and no longer needs repairing. What is
 * left in its place is a verification that this is true, plus a per-branch row
 * census so the back-fill can be eyeballed before anything else is trusted:
 * anything that could not be resolved from a related record was placed on the
 * default location, and that is a guess worth looking at once.
 *
 * Step 2 is unchanged and is still the point: rebuild `InventoryStock.available`
 * as the sum of the movements for each (item, branch, shelf).
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

/** Tables the migration made branch-required. None may hold a NULL. */
const REQUIRED = [
  'stock_movements', 'stock_batches', 'wastage_records', 'stock_counts',
  'purchases', 'goods_receipts', 'purchase_returns', 'cash_drawer_sessions',
  'storage_locations', 'shift_notes', 'orders', 'restaurant_tables',
] as const

async function main() {
  console.log(APPLY ? '── APPLYING CHANGES ──\n' : '── dry run: nothing will be written ──\n')

  // ── 1. did the back-fill leave anything behind? ────────────────────────────
  console.log('branch coverage')
  let unplaced = 0
  for (const table of REQUIRED) {
    const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; missing: bigint }>>(
      `SELECT COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE "branchId" IS NULL)::bigint AS missing
         FROM "${table}"`,
    )
    const { total, missing } = rows[0]
    unplaced += Number(missing)
    const mark = Number(missing) === 0 ? '✓' : '✗'
    console.log(`  ${mark} ${table.padEnd(22)} ${String(total).padStart(7)} rows${Number(missing) ? `, ${missing} WITHOUT A BRANCH` : ''}`)
  }
  if (unplaced > 0) {
    console.log('\n  Some rows have no location. The migration should have made that')
    console.log('  impossible, so this means it has not been applied here yet.')
  }

  // How the movements were spread. A back-fill that put everything on one
  // location is not wrong — a single-site restaurant looks exactly like that —
  // but on a multi-site one it is worth a second look before --apply.
  const spread = await prisma.$queryRaw<Array<{ name: string; code: string; n: bigint }>>`
    SELECT b."name", b."code", COUNT(m.*)::bigint AS n
      FROM "branches" b LEFT JOIN "stock_movements" m ON m."branchId" = b."id"
     GROUP BY b."id", b."name", b."code"
     ORDER BY n DESC
  `
  console.log('\nmovements per location')
  for (const row of spread) {
    console.log(`  ${row.name.padEnd(24)} ${row.code.padEnd(8)} ${String(row.n).padStart(7)}`)
  }
  console.log()

  // ── 2. rebuild available from the ledger ───────────────────────────────────
  const grouped = await prisma.stockMovement.groupBy({
    by: ['restaurantId', 'itemId', 'branchId', 'locationId'],
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
        branchId: row.branchId,
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
          branchId: row.branchId,
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
