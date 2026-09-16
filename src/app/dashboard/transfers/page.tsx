import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { listTransfers, type TransferSummary } from '@/features/transfers/queries'
import { sectionFor, type TransferSection } from '@/features/transfers/sections'
import { branchNameFor, scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can, canAccessBranch } from '@/lib/rbac'
import { SearchBox } from '@/components/search-box'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Transfers' }

const STATUS: Record<string, { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }> = {
  REQUESTED: { label: 'Requested', variant: 'secondary' },
  APPROVED: { label: 'Approved', variant: 'success' },
  DISPATCHED: { label: 'On its way', variant: 'warning' },
  IN_TRANSIT: { label: 'In transit', variant: 'warning' },
  RECEIVED: { label: 'Received', variant: 'success' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}


export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.TRANSFER_VIEW, '/dashboard/transfers')

  /*
   * This used to read `ids && ids.length === 1 ? ids[0] : null`, which failed
   * open: a warehouse worker with no location assigned got `[]`, the ternary
   * fell through to null, and they saw every transfer in the restaurant.
   * `scopeToOne` returns an id that matches nothing in that case, so the answer
   * is "none" rather than "all".
   */
  const params = await searchParams
  const search = (typeof params.search === 'string' ? params.search : '').trim()
  const selection = await selectedBranch(user, params)
  const [transfers, branchName] = await Promise.all([
    listTransfers({
      restaurantId: user.restaurantId,
      branchId: scopeToOne(selection),
      search,
    }),
    branchNameFor(user.restaurantId, selection.branchId),
  ])

  // The list, in the four states a transfer waits in (recorrection.md §1),
  // filed by status and by which end the viewer stands at — see `sectionFor`.
  const sections: Record<TransferSection, Array<{ t: TransferSummary; hint: string }>> = {
    approval: [], dispatch: [], receive: [], closed: [],
  }
  for (const t of transfers) {
    const atSource = canAccessBranch(user, t.fromBranchId)
    const atDestination = canAccessBranch(user, t.toBranchId)
    const [section, hint] = sectionFor(t, atSource, atDestination)
    sections[section].push({ t, hint })
  }

  const waiting = sections.approval.length + sections.dispatch.length + sections.receive.length

  return (
    <>
      <PageHeader
        title="Transfers"
        branch={branchName}
        description="Stock moving between locations. The branch that needs it asks; the source approves and sends; it arrives on receipt."
        actions={
          <>
            {can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="transfers" /> : null}
            {can(user, PERMISSIONS.TRANSFER_REQUEST) ? (
              <Button asChild>
                <Link href="/dashboard/transfers/new">Request stock</Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 max-w-sm">
        <SearchBox placeholder="Transfer number, location or item…" defaultValue={search} />
      </div>

      {transfers.length === 0 ? (
        <SectionCard title="Transfers">
          <EmptyState
            title={search ? `Nothing matches “${search}”` : 'No transfers yet'}
            description={
              search
                ? 'Try the transfer number, either location, or an item that was moved.'
                : 'Ask another location for stock, and it shows up here at every step until it arrives.'
            }
          />
        </SectionCard>
      ) : null}

      {sections.approval.length > 0 && (
        <Group
          title="Pending approval"
          count={sections.approval.length}
          description="Requested and not yet ruled on. The source decides on the Approvals desk."
          rows={sections.approval}
        />
      )}
      {sections.dispatch.length > 0 && (
        <Group
          title="Pending dispatch"
          count={sections.dispatch.length}
          description="Approved and reserved. Stock leaves when it is dispatched."
          rows={sections.dispatch}
        />
      )}
      {sections.receive.length > 0 && (
        <Group
          title="Pending receive"
          count={sections.receive.length}
          description="On its way, or approved and being prepared. It arrives when the destination receives it."
          rows={sections.receive}
        />
      )}
      {sections.closed.length > 0 && (
        <Group
          title={waiting > 0 ? 'Completed and closed' : 'All transfers'}
          count={sections.closed.length}
          description="Finished, rejected or cancelled."
          rows={sections.closed}
        />
      )}
    </>
  )
}

function Group({
  title,
  count,
  description,
  rows,
}: {
  title: string
  count: number
  description: string
  rows: Array<{ t: TransferSummary; hint: string }>
}) {
  return (
    <SectionCard title={`${title} (${count})`} description={description}>
      <ul className="divide-y divide-border">
        {rows.map(({ t, hint }) => <Row key={t.id} t={t} hint={hint} />)}
      </ul>
    </SectionCard>
  )
}

function Row({ t, hint }: { t: TransferSummary; hint: string }) {
  const status = STATUS[t.status] ?? STATUS.REQUESTED
  const mine = hint.includes('on you')
  return (
    <li>
      <Link
        href={`/dashboard/transfers/${t.id}`}
        className="-mx-2 flex flex-wrap items-center gap-3 rounded-lg px-2 py-3 hover:bg-muted"
      >
        <span className="font-medium tabular-nums">{t.number}</span>
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="text-sm">{t.fromName} → {t.toName}</span>
        <span className="text-sm text-muted-foreground">
          {t.lineCount} item{t.lineCount === 1 ? '' : 's'}
        </span>
        {t.hasVariance && <Badge variant="destructive">variance</Badge>}
        {hint ? (
          <span className={mine ? 'text-xs font-medium text-primary' : 'text-xs text-muted-foreground'}>
            {hint}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          <LocalDateTime value={t.requestedAt} />
          {t.requestedByName ? ` · ${t.requestedByName}` : ''}
        </span>
      </Link>
    </li>
  )
}
