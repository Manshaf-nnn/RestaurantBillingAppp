import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { listRecipeRows } from '@/features/recipes/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Recipes' }

export default async function RecipesPage() {
  const user = await requirePagePermission(PERMISSIONS.MENU_VIEW, '/dashboard/recipes')
  const restaurant = await requireRestaurant(user.restaurantId)
  const rows = await listRecipeRows(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const withoutRecipe = rows.filter((r) => !r.hasRecipe).length

  return (
    <>
      <PageHeader
        title="Recipes"
        description="What each dish costs to make. Highest food cost first — those are the ones eating your margin."
      />

      {withoutRecipe > 0 && (
        <div className="mb-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          {withoutRecipe} dish{withoutRecipe === 1 ? '' : 'es'} have no recipe. Those do not deplete
          stock when sold, and their profit is unknown.
        </div>
      )}

      <SectionCard title="Menu">
        {rows.length === 0 ? (
          <EmptyState title="No dishes yet" description="Add menu items first, then give them recipes." />
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Dish</th>
                  <th className="pb-2 pr-3 text-right font-medium">Price</th>
                  <th className="pb-2 pr-3 text-right font-medium">Cost</th>
                  <th className="pb-2 pr-3 text-right font-medium">Profit</th>
                  <th className="pb-2 pr-3 text-right font-medium">Food cost</th>
                  <th className="pb-2 font-medium">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const pct = row.foodCostPercent
                  const tone =
                    pct === null ? '' : pct > 40 ? 'text-red-600 dark:text-red-400'
                      : pct > 30 ? 'text-amber-600 dark:text-amber-400'
                        : 'text-emerald-600 dark:text-emerald-400'
                  return (
                    <tr key={row.foodId}>
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/dashboard/recipes/${row.foodId}`}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {row.foodName}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{money(row.price)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                        {row.hasRecipe ? money(row.ingredientCost) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {row.hasRecipe ? money(row.price - row.ingredientCost) : '—'}
                      </td>
                      <td className={`py-2.5 pr-3 text-right tabular-nums font-medium ${tone}`}>
                        {pct === null ? <Badge variant="secondary">no recipe</Badge> : `${pct.toFixed(1)}%`}
                      </td>
                      <td className="py-2.5">
                        {row.stockWarning ? (
                          <span
                            className={`inline-flex items-center gap-1 text-xs ${
                              row.stockWarning === 'OUT_OF_STOCK'
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-amber-600 dark:text-amber-400'
                            }`}
                            title={row.shortIngredients.join(', ')}
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {row.stockWarning === 'OUT_OF_STOCK' ? 'Cannot make' : 'Running low'}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  )
}
