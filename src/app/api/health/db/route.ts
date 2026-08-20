import { NextResponse } from 'next/server'

import { toAppError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Schema drift check.
 *
 * The commonest cause of a healthy build serving broken pages is a database
 * missing columns the generated client expects — a deploy that shipped code
 * ahead of its migration. Prisma reports that as P2022 with no indication of
 * which column or which page, which is close to useless on a live site.
 *
 * This compares what the code expects against what the database actually has
 * and names the gap. Owner-only, because the answer describes the shape of the
 * database.
 */
const EXPECTED_COLUMNS: Array<{ table: string; column: string; since: string }> = [
  { table: 'branches', column: 'type', since: 'locations_transfers_production' },
  { table: 'orders', column: 'servedById', since: 'order_served_by' },
  { table: 'orders', column: 'channel', since: 'branches_cash_drawer_order_channel' },
  { table: 'orders', column: 'branchId', since: 'branches_cash_drawer_order_channel' },
  { table: 'order_items', column: 'recipeId', since: 'recipes_and_depletion' },
  { table: 'customers', column: 'marketingConsent', since: 'customers_and_discounts' },
  { table: 'customers', column: 'group', since: 'customers_and_discounts' },
  { table: 'inventory_items', column: 'minStock', since: 'inventory_ledger' },
  { table: 'inventory_items', column: 'useFefo', since: 'wastage_batches_expiry' },
  { table: 'coupons', column: 'scope', since: 'customers_and_discounts' },
  { table: 'suppliers', column: 'paymentTerms', since: 'purchasing' },
  { table: 'purchases', column: 'subtotal', since: 'purchasing' },
]

const EXPECTED_TABLES = [
  'branches', 'cash_drawer_sessions', 'inventory_stock', 'stock_transfers',
  'production_orders', 'production_specs', 'recipes', 'wastage_records',
  'stock_batches', 'stock_counts', 'goods_receipts', 'approval_requests',
]

export async function GET() {
  try {
    await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

    const [tables, columns, migrations] = await Promise.all([
      prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY(${EXPECTED_TABLES})
      `,
      prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
      `,
      prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations" ORDER BY started_at ASC
      `,
    ])

    const have = new Set(columns.map((c) => `${c.table_name}.${c.column_name}`))
    const haveTables = new Set(tables.map((t) => t.table_name))

    const missingTables = EXPECTED_TABLES.filter((t) => !haveTables.has(t))
    const missingColumns = EXPECTED_COLUMNS
      .filter((e) => !have.has(`${e.table}.${e.column}`))
      .map((e) => ({ ...e, hint: `the ${e.since} migration has not run` }))
    const stuckMigrations = migrations
      .filter((m) => !m.finished_at && !m.rolled_back_at)
      .map((m) => m.migration_name)

    const healthy =
      missingTables.length === 0 && missingColumns.length === 0 && stuckMigrations.length === 0

    return NextResponse.json(
      {
        healthy,
        summary: healthy
          ? 'Database matches the deployed code.'
          : 'The database is behind the deployed code — deploy again so migrations run.',
        missingTables,
        missingColumns,
        stuckMigrations,
        migrationsApplied: migrations.filter((m) => m.finished_at).length,
      },
      { status: healthy ? 200 : 500 },
    )
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}
