'use client'

import * as React from 'react'
import { Timer } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { MakeItemForm } from './make-item-form'
import { PreparedItemsTable } from './prepared-items-table'
import { PreparedItemDetail } from './prepared-item-detail'
import { ProductionHistory } from './production-history'
import type { ProductionWorkspaceData } from '../types'

/**
 * Kitchen Production: three tabs on one screen (redesignkitchenjob.md), one
 * flow through them (recorrection.md §3):
 *
 *   Make an Item — create the prepared item and its batch
 *   Prepared Items — every item, in progress or stocked; Mark Done lives here
 *   Production History — the runs
 *
 * The server page hands this component plain data and nothing else; the
 * cross-tab moves — "Make more", "Later", "Full history" — are state held
 * here, so the page never has to pass a function across the boundary.
 *
 * Batches in progress used to be a card above the tabs. They are rows on
 * Prepared Items now, in that state, because a batch IS a prepared item that
 * is not stocked yet — one list, two states, rather than two lists that the
 * cook had to reconcile. The one-line note above the tabs keeps the count
 * from being buried.
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
  const [historyItem, setHistoryItem] = React.useState<string | null>(null)
  const [prefill, setPrefill] = React.useState<{ itemId: string; name: string } | null>(null)
  const [detailItem, setDetailItem] = React.useState<string | null>(null)

  const inProgress = data.openBatches.length
  const makeMore = (itemId: string, name: string) => {
    setDetailItem(null)
    // A fresh object each time, so making the same item twice in a row
    // re-fills the form both times.
    setPrefill({ itemId, name })
    setTab('make')
  }

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
            <strong>{inProgress} batch{inProgress === 1 ? '' : 'es'} in progress</strong> — nothing has left stock for {inProgress === 1 ? 'it' : 'them'} yet. Mark {inProgress === 1 ? 'it' : 'them'} done on Prepared Items.
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
              prefill={prefill}
              onLater={() => setTab('prepared')}
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
            onDetails={(itemId) => setDetailItem(itemId)}
            onMakeMore={makeMore}
          />
        </TabsContent>

        <TabsContent value="history">
          <ProductionHistory
            rows={data.history}
            currency={currency}
            locale={locale}
            filterItemId={historyItem}
            onClearFilter={() => setHistoryItem(null)}
          />
        </TabsContent>
      </Tabs>

      <PreparedItemDetail
        itemId={detailItem}
        data={data}
        currency={currency}
        locale={locale}
        canManage={canManage}
        onClose={() => setDetailItem(null)}
        onMakeMore={makeMore}
        onHistory={(itemId) => {
          setDetailItem(null)
          setHistoryItem(itemId)
          setTab('history')
        }}
      />
    </>
  )
}
