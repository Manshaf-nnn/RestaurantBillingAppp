import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { listTransfers } from '@/features/transfers/queries'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can } from '@/lib/rbac'
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
  const transfers = await listTransfers({
    restaurantId: user.restaurantId,
    branchId: scopeToOne(selection),
    search,
  })

  const open = transfers.filter((t) => !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(t.status))

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Stock moving between locations. It leaves on dispatch and arrives on receipt — never both at once."
        actions={
          can(user, PERMISSIONS.TRANSFER_REQUEST) ? (
            <Button asChild>
              <Link href="/dashboard/transfers/new">New transfer</Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-4 max-w-sm">
        <SearchBox placeholder="Transfer number, location or item…" defaultValue={search} />
      </div>

      {open.length > 0 && (
        <SectionCard title="In progress" description="Requested, approved or on the road." >
          <ul className="divide-y divide-border">
            {open.map((t) => <Row key={t.id} t={t} />)}
          </ul>
        </SectionCard>
      )}

      <SectionCard title="All transfers">
        {transfers.length === 0 ? (
          <EmptyState
            title={search ? `Nothing matches “${search}”` : 'No transfers yet'}
            description={
              search
                ? 'Try the transfer number, either location, or an item that was moved.'
                : 'Move stock between branches, a warehouse or the production house.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {transfers.map((t) => <Row key={t.id} t={t} />)}
          </ul>
        )}
      </SectionCard>
    </>
  )
}

function Row({ t }: { t: Awaited<ReturnType<typeof listTransfers>>[number] }) {
  const status = STATUS[t.status] ?? STATUS.REQUESTED
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
        <span className="ml-auto text-xs text-muted-foreground">
          <LocalDateTime value={t.requestedAt} />
          {t.requestedByName ? ` · ${t.requestedByName}` : ''}
        </span>
      </Link>
    </li>
  )
}
