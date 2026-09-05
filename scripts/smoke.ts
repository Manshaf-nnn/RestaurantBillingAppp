/** Calls the queries behind the failing pages directly, so the real error surfaces. */
import { prisma } from '../src/server/db/prisma'
import { listLocations } from '../src/features/transfers/queries'
import { getCustomerAnalytics } from '../src/features/customers/analytics'
import { getInventorySummary, listStockAlerts } from '../src/features/inventory/alerts'
import { getReorderSuggestions } from '../src/features/purchasing/suggestions'
import { listPurchaseOrders } from '../src/features/purchasing/queries'
import { getProductionWorkspace } from '../src/features/production/queries'
import { listApprovals } from '../src/features/approvals/service'
import { getVarianceReport } from '../src/features/inventory/variance-report'
import { getWastageReport } from '../src/features/inventory/wastage'
import { listExpiringStock } from '../src/features/inventory/batches'
import { getSalesReport, getPaymentsReport } from '../src/features/reports/sales'
import { getProfitReport, getBranchComparison } from '../src/features/reports/profit'
import { resolveRange } from '../src/features/reports/range'
import { listRecipeRows } from '../src/features/recipes/queries'

async function main() {
  const r = await prisma.restaurant.findFirstOrThrow({ select: { id: true, slug: true } })
  const range = resolveRange({ preset: 'THIS_MONTH' })
  const checks: Array<[string, () => Promise<unknown>]> = [
    ['listLocations', () => listLocations(r.id)],
    ['customer analytics', () => getCustomerAnalytics({ restaurantId: r.id })],
    ['inventory summary', () => getInventorySummary({ restaurantId: r.id })],
    ['stock alerts', () => listStockAlerts({ restaurantId: r.id })],
    ['reorder suggestions', () => getReorderSuggestions({ restaurantId: r.id })],
    ['purchase orders', () => listPurchaseOrders({ restaurantId: r.id })],
    ['production workspace', () => getProductionWorkspace({ restaurantId: r.id, branchId: null })],
    ['approvals', () => listApprovals({ restaurantId: r.id })],
    ['variance report', () => getVarianceReport({ restaurantId: r.id, days: 30 })],
    ['wastage report', () => getWastageReport({ restaurantId: r.id, period: 'MONTH' })],
    ['expiring stock', () => listExpiringStock({ restaurantId: r.id })],
    ['sales report', () => getSalesReport({ restaurantId: r.id, range })],
    ['payments report', () => getPaymentsReport({ restaurantId: r.id, range })],
    ['profit report', () => getProfitReport({ restaurantId: r.id, range })],
    ['branch comparison', () => getBranchComparison({ restaurantId: r.id, range })],
    ['recipe rows', () => listRecipeRows(r.id)],
  ]
  let bad = 0
  for (const [name, fn] of checks) {
    try { await fn(); console.log(`  ✓ ${name}`) }
    catch (e) { bad++; console.log(`  ✗ ${name}\n      ${(e as Error).message.split('\n').slice(0, 4).join('\n      ')}`) }
  }
  console.log(bad === 0 ? '\nall queries OK\n' : `\n${bad} failing\n`)
  await prisma.$disconnect()
}
main()
