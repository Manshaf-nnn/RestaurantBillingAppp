'use client'

import * as React from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { MakeItemForm } from './make-item-form'
import { PreparedItemsTable } from './prepared-items-table'
import { ProductionHistory } from './production-history'
import type { ProductionWorkspaceData } from '../types'

/**
 * Kitchen Production: three tabs on one screen (redesignkitchenjob.md).
 *
 *   Make Item · Prepared Items · Production History
 *
 * The server page hands this component plain data and nothing else; the
 * cross-tab moves — "History" on a prepared item, "Make more" — are state held
 * here, so the page never has to pass a function across the boundary.
 */
export function ProductionWorkspace({
  data,
  branches,
  branchId,
  currency,
  locale,
  canManage,
}: {
  data: ProductionWorkspaceData
  branches: Array<{ id: string; name: string }>
  branchId: string | null
  currency: string
  locale: string
  canManage: boolean
}) {
  const [tab, setTab] = React.useState<'make' | 'prepared' | 'history'>(canManage ? 'make' : 'prepared')
  const [historyItem, setHistoryItem] = React.useState<string | null>(null)
  const [prefillName, setPrefillName] = React.useState<string | null>(null)

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
      <TabsList>
        {canManage ? <TabsTrigger value="make">Make Item</TabsTrigger> : null}
        <TabsTrigger value="prepared">Prepared Items ({data.prepared.length})</TabsTrigger>
        <TabsTrigger value="history">Production History</TabsTrigger>
      </TabsList>

      {canManage ? (
        <TabsContent value="make">
          <MakeItemForm
            items={data.items}
            branches={branches}
            branchId={branchId}
            currency={currency}
            locale={locale}
            prefillName={prefillName}
          />
        </TabsContent>
      ) : null}

      <TabsContent value="prepared">
        <PreparedItemsTable
          rows={data.prepared}
          currency={currency}
          locale={locale}
          canManage={canManage}
          onHistory={(itemId) => {
            setHistoryItem(itemId)
            setTab('history')
          }}
          onMakeMore={(name) => {
            setPrefillName(name)
            setTab('make')
          }}
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
  )
}
