'use client'

import * as React from 'react'
import Link from 'next/link'
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
 *   Make an Item / Production — recipe → stock check → production order,
 *                               then the order's own page for issue and completion
 *   Prepared / Produced Items — every item, in progress or stocked
 *   Production History        — every run, whatever state it is in
 *
 * Orders in progress are listed under the steps, so a cook who left the
 * screen mid-shift gets back to the one they were on without hunting.
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
}: {
  data: ProductionWorkspaceData
  branchId: string | null
  branchName: string | null
  branchIsFallback: boolean
  currency: string
  locale: string
  canManage: boolean
  prefill: { itemId: string; name: string; step?: 1 | 2 | 3 } | null
}) {
  const [tab, setTab] = React.useState<'make' | 'prepared' | 'history'>(canManage ? 'make' : 'prepared')

  const inProgress = data.openBatches.length

  return (
    <>
      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
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
