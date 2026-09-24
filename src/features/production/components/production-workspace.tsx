'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Timer } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LocalDateTime } from '@/components/local-time'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { UNIT_LABELS } from '@/features/inventory/units'
import { MakeItemForm } from './make-item-form'
import { PreparedItemsTable } from './prepared-items-table'
import { ProductionHistory } from './production-history'
import type { ProductionWorkspaceData } from '../types'

/**
 * Kitchen Production: three tabs (pro.b.md §11), one flow through them:
 *
 *   Make an Item / Production — the recipe, then the saved recipes to produce
 *                               from; the order's own page issues and completes
 *   Prepared / Produced Items — every item, in progress or stocked
 *   Production History        — every run, whatever state it is in
 *
 * Orders in progress are listed under the tab, so a cook who left the screen
 * mid-shift gets back to the one they were on without hunting.
 *
 * ── Why the tab lives in the URL ────────────────────────────────────────────
 *
 * It was React state, and that quietly broke "Make more" on the Prepared tab.
 * That button links to `?make=<id>` on THIS route — a soft same-route
 * navigation, which re-renders the server component and preserves client
 * state. So the tab stayed on Prepared, and `MakeItemForm` was not even
 * mounted (Radix unmounts an inactive `TabsContent`), so the effect that reads
 * the prefill never ran. The button appeared to do nothing at all.
 *
 * With the tab in the URL the server decides which one is open, so a link can
 * point at a tab — which is what that button was always trying to do.
 */
export function ProductionWorkspace({
  data,
  branchId,
  branchName,
  branchIsFallback,
  currency,
  locale,
  canManage,
  prefill,
  tab,
}: {
  data: ProductionWorkspaceData
  branchId: string | null
  branchName: string | null
  branchIsFallback: boolean
  currency: string
  locale: string
  canManage: boolean
  prefill: { itemId: string; name: string; order?: boolean } | null
  /** Which tab the URL asks for, already resolved against `canManage`. */
  tab: 'make' | 'prepared' | 'history'
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const go = (next: string) => {
    const query = new URLSearchParams(params.toString())
    if (next === (canManage ? 'make' : 'prepared')) query.delete('tab')
    else query.set('tab', next)
    // Switching tab by hand drops whichever recipe a link had opened.
    query.delete('make')
    query.delete('recipe')
    const search = query.toString()
    router.push(search ? `${pathname}?${search}` : pathname, { scroll: false })
  }

  const inProgress = data.openBatches.length

  return (
    <>
      <Tabs value={tab} onValueChange={go}>
        <TabsList>
          {canManage ? <TabsTrigger value="make">Make an Item / Production</TabsTrigger> : null}
          <TabsTrigger value="prepared">Prepared / Produced Items ({data.prepared.length})</TabsTrigger>
          <TabsTrigger value="history">Production History</TabsTrigger>
        </TabsList>

        {canManage ? (
          <TabsContent value="make">
            <div className="space-y-6">
              <MakeItemForm
                items={data.items}
                recipes={data.recipes}
                openBatches={data.openBatches}
                branchId={branchId}
                branchName={branchName}
                branchIsFallback={branchIsFallback}
                currency={currency}
                locale={locale}
                prefill={prefill}
              />

              {inProgress > 0 ? (
                <section className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-4 dark:border-amber-700/50 dark:bg-amber-950/30">
                  <p className="mb-3 flex items-center gap-2 text-sm font-medium">
                    <Timer className="size-4" />
                    {inProgress} production order{inProgress === 1 ? '' : 's'} in progress at {branchName ?? 'this location'}
                  </p>
                  <ul className="divide-y divide-amber-200/60 dark:divide-amber-800/40">
                    {data.openBatches.map((batch) => (
                      <li key={batch.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span>
                          <span className="font-mono text-xs text-muted-foreground">{batch.number}</span>{' '}
                          <span className="font-medium">{batch.name}</span>{' '}
                          <span className="text-muted-foreground">
                            · planned {batch.plannedQty} {batch.unit ? UNIT_LABELS[batch.unit].toLowerCase() : ''} · <LocalDateTime value={batch.startedAt} />
                          </span>
                          {batch.issued ? <Badge variant="warning" size="sm" className="ml-2">issued</Badge> : null}
                        </span>
                        <Button size="sm" asChild>
                          <Link href={`/dashboard/production/${batch.id}`}>{batch.issued ? 'Complete production' : 'Issue ingredients'}</Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </TabsContent>
        ) : null}

        <TabsContent value="prepared">
          <PreparedItemsTable
            rows={data.prepared}
            openBatches={data.openBatches}
            currency={currency}
            locale={locale}
            canManage={canManage}
          />
        </TabsContent>

        <TabsContent value="history">
          <ProductionHistory rows={data.history} currency={currency} locale={locale} />
        </TabsContent>
      </Tabs>
    </>
  )
}
