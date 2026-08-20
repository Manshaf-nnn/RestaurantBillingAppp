import { NextResponse } from 'next/server'

import { toAppError } from '@/lib/errors'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { resolveRange } from '@/features/reports/range'

/**
 * Run every dashboard page's data loader and report which one throws.
 *
 * A failing server component reaches the browser as a digest and nothing else —
 * Next strips the message in production, correctly, because an unfiltered
 * database error names tables and columns to anyone who can load the page. That
 * leaves the person looking at a broken screen with a hash and no way to act.
 *
 * This calls the same loaders behind an owner-only check, where returning the
 * message is safe, and says which one failed and why. It is the difference
 * between "a page is broken" and "getCustomerAnalytics threw P2022 on
 * customers.group".
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  try {
    const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
    const restaurant = await requireRestaurant(user.restaurantId)
    const rid = user.restaurantId
    const branchIds = visibleBranchIds({ role: user.role, branchId: user.branchId })
    const range = resolveRange({ preset: 'THIS_MONTH' })
    const currency = restaurant.currency

    // Imported lazily so one broken module cannot stop the others being tested.
    const checks: Array<[string, () => Promise<unknown>]> = [
      ['dashboard: stats', async () =>
        (await import('@/features/analytics/queries')).getDashboardStats(rid)],
      ['dashboard: locations', async () =>
        (await import('@/features/transfers/queries')).listSwitchableLocations(rid)],
      ['locations: list', async () =>
        (await import('@/features/transfers/queries')).listLocations(rid)],
      ['inventory: summary', async () =>
        (await import('@/features/inventory/alerts')).getInventorySummary({ restaurantId: rid })],
      ['inventory: alerts', async () =>
        (await import('@/features/inventory/alerts')).listStockAlerts({ restaurantId: rid })],
      ['inventory: expiry', async () =>
        (await import('@/features/inventory/batches')).listExpiringStock({ restaurantId: rid })],
      ['inventory: wastage report', async () =>
        (await import('@/features/inventory/wastage')).getWastageReport({ restaurantId: rid, period: 'MONTH' })],
      ['inventory: variance', async () =>
        (await import('@/features/inventory/variance-report')).getVarianceReport({ restaurantId: rid, days: 30 })],
      ['inventory: stock counts', async () =>
        (await import('@/features/inventory/count-queries')).listStockCounts({ restaurantId: rid })],
      ['purchasing: orders', async () =>
        (await import('@/features/purchasing/queries')).listPurchaseOrders({ restaurantId: rid })],
      ['purchasing: suggestions', async () =>
        (await import('@/features/purchasing/suggestions')).getReorderSuggestions({ restaurantId: rid })],
      ['purchasing: builder', async () =>
        (await import('@/features/purchasing/queries')).getPoBuilderData({ restaurantId: rid, currency })],
      ['suppliers: list', async () =>
        (await import('@/features/purchasing/queries')).listSuppliersWithCounts(rid)],
      ['transfers: list', async () =>
        (await import('@/features/transfers/queries')).listTransfers({ restaurantId: rid })],
      ['transfers: builder', async () =>
        (await import('@/features/transfers/queries')).getTransferBuilderData(rid)],
      ['production: dashboard', async () =>
        (await import('@/features/production/queries')).getProductionDashboard({ restaurantId: rid })],
      ['production: console', async () =>
        (await import('@/features/production/queries')).getProductionConsoleData({ restaurantId: rid, currency })],
      ['recipes: list', async () =>
        (await import('@/features/recipes/queries')).listRecipeRows(rid)],
      ['approvals: list', async () =>
        (await import('@/features/approvals/service')).listApprovals({ restaurantId: rid, branchIds })],
      ['customers: analytics', async () =>
        (await import('@/features/customers/analytics')).getCustomerAnalytics({ restaurantId: rid })],
      ['reports: sales', async () =>
        (await import('@/features/reports/sales')).getSalesReport({ restaurantId: rid, range, branchIds })],
      ['reports: payments', async () =>
        (await import('@/features/reports/sales')).getPaymentsReport({ restaurantId: rid, range, branchIds })],
      ['reports: profit', async () =>
        (await import('@/features/reports/profit')).getProfitReport({ restaurantId: rid, range, branchIds })],
      ['reports: branch comparison', async () =>
        (await import('@/features/reports/profit')).getBranchComparison({ restaurantId: rid, range, branchIds })],
      ['cash drawer', async () =>
        (await import('@/features/cashdrawer/queries')).getDrawerPageData({
          restaurantId: rid, userId: user.id, currency, canSeeAll: true,
        })],
      ['menu: public', async () =>
        (await import('@/features/menu/queries')).getPublicMenu(rid, restaurant.timezone)],
    ]

    const failing: Array<{ check: string; message: string; code?: string; kind: string }> = []
    const okChecks: string[] = []

    for (const [name, run] of checks) {
      const started = Date.now()
      try {
        await run()
        okChecks.push(`${name} (${Date.now() - started}ms)`)
      } catch (error) {
        const e = error as Error & { code?: string }
        failing.push({
          check: name,
          kind: e.name ?? 'Error',
          code: e.code,
          // Trimmed: Prisma errors carry a long formatted body and only the
          // first lines identify the fault.
          message: (e.message ?? String(error)).split('\n').slice(0, 6).join(' ').slice(0, 500),
        })
      }
    }

    return NextResponse.json(
      {
        healthy: failing.length === 0,
        summary: failing.length === 0
          ? 'Every dashboard query succeeded. If a page still fails, the fault is in rendering rather than data.'
          : `${failing.length} of ${checks.length} queries failed — see failing[] below.`,
        failing,
        passed: okChecks,
      },
      { status: failing.length === 0 ? 200 : 500 },
    )
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}
