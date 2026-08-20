/**
 * Read-only diagnostic for a stuck migration. Changes nothing.
 *
 * A half-applied migration can be in one of two states, and the fix for each
 * is the opposite of the other — so this reports what is actually there rather
 * than guessing.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const EXPECTED = ['recipes', 'recipe_ingredients', 'order_stock_depletions']

async function main() {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${EXPECTED})
  `
  const found = tables.map((t) => t.table_name)

  console.log('\nTables this migration should have created:')
  for (const t of EXPECTED) console.log(`  ${found.includes(t) ? '✓ exists' : '✗ missing'}  ${t}`)

  const col = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'order_items' AND column_name = 'recipeId'
  `
  console.log(`  ${col.length ? '✓ exists' : '✗ missing'}  order_items.recipeId`)

  const enumVal = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'StockMovementType' AND e.enumlabel = 'SALE_REVERSAL'
  `
  console.log(`  ${enumVal.length ? '✓ exists' : '✗ missing'}  StockMovementType.SALE_REVERSAL`)

  const rows = await prisma.$queryRaw<Array<{
    migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; logs: string | null
  }>>`
    SELECT migration_name, finished_at, rolled_back_at, logs
    FROM "_prisma_migrations" ORDER BY started_at ASC
  `
  console.log('\nMigration history in Neon:')
  for (const r of rows) {
    const state = r.rolled_back_at ? 'ROLLED BACK' : r.finished_at ? 'applied' : '>>> STUCK <<<'
    console.log(`  ${state.padEnd(14)} ${r.migration_name}`)
    if (!r.finished_at && r.logs) console.log(`      error: ${r.logs.split('\n')[0].slice(0, 160)}`)
  }

  // The verdict has to account for a *retry*: a failed attempt followed by a
  // successful one leaves two rows for the same migration. In that case the
  // schema is already correct and the fix is to mark the failed attempt rolled
  // back — marking it applied would collide with the row that already says so.
  const stuck = rows.filter((r) => !r.finished_at && !r.rolled_back_at)
  const alsoApplied = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name))
  const retried = stuck.some((r) => alsoApplied.has(r.migration_name))

  const verdict =
    stuck.length === 0
      ? 'nothing stuck — no action needed'
      : retried
        ? 'a later attempt already succeeded and the schema is correct — mark the FAILED ATTEMPT as ROLLED BACK'
        : found.length === EXPECTED.length
          ? 'objects exist and there is no successful row — mark as APPLIED'
          : found.length === 0
            ? 'nothing landed — mark as ROLLED BACK, then re-run'
            : 'PARTIAL — do not guess, send this output to someone who can read it'

  console.log(`\nVERDICT: ${verdict}\n`)
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1) })
