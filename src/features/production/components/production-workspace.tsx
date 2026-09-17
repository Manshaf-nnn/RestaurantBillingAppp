'use client'

import * as React from 'react'
import { Timer } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { MakeItemForm } from './make-item-form'
import { PreparedItemsTable } from './prepared-items-table'
import { ProductionHistory } from './production-history'
import type { ProductionWorkspaceData } from '../types'

/**
 * Kitchen Production: three tabs on one screen (aO.md §5), one flow through
 * them:
 *
 *   Make an Item — create the prepared item and its batch
 *   Prepared Items — every item, in progress or stocked
 *   Production History — every run, whatever state it is in
 *
 * The server page hands this component plain data and nothing else.
 *
 * A prepared item's own page is where the making happens after Create: "How
 * much did you make?", Make Done and Make More all live there, so the row
 * here is a link rather than a dialog. One screen per item, reachable by its
 * own address, is also what lets a cook keep it open on a phone while the
 * pot finishes.
 *
 * Batches in progress are rows on Prepared Items in that state, because a
 * batch IS a prepared item that is not stocked yet — one list, two states,
 * rather than two lists the cook had to reconcile. The one-line note above
 * the tabs keeps the count from being buried.
 */
export function ProductionWorkspace({
  data,
  branchId,
  branchName,
  branchIsFallback,
  currency,
  locale,
  canManage,
}: {
  data: ProductionWorkspaceData
  branchId: string | null
  branchName: string | null
  branchIsFallback: boolean
  currency: string
  locale: string
  canManage: boolean
}) {
  const [tab, setTab] = React.useState<'make' | 'prepared' | 'history'>(canManage ? 'make' : 'prepared')

  const inProgress = data.openBatches.length

  return (
    <>
      {inProgress > 0 ? (
        <button
          type="button"
          onClick={() => setTab('prepared')}
          className="mb-4 flex w-full items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <Timer className="size-4 shrink-0" />
          <span>
            <strong>{inProgress} batch{inProgress === 1 ? '' : 'es'} in progress</strong> — nothing has left stock for {inProgress === 1 ? 'it' : 'them'} yet. Open {inProgress === 1 ? 'it' : 'them'} on Prepared Items to say how much you made.
          </span>
        </button>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <TabsList>
          {canManage ? <TabsTrigger value="make">Make an Item</TabsTrigger> : null}
          <TabsTrigger value="prepared">Prepared Items ({data.prepared.length})</TabsTrigger>
          <TabsTrigger value="history">Production History</TabsTrigger>
        </TabsList>

        {canManage ? (
          <TabsContent value="make">
            <MakeItemForm
              items={data.items}
              recipes={data.recipes}
              branchId={branchId}
              branchName={branchName}
              branchIsFallback={branchIsFallback}
              currency={currency}
              locale={locale}
              prefill={null}
            />
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
