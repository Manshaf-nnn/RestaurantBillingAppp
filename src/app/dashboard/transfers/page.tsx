import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { listTransfers } from '@/features/transfers/queries'
import { PERMISSIONS, visibleBranchIds, can} from '@/lib/rbac'
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

export default async function TransfersPage() {
  const user = await requirePagePermission(PERMISSIONS.TRANSFER_VIEW, '/dashboard/transfers')

  // Confined users only see movements touching their own location.
  const ids = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const transfers = await listTransfers({
    restaurantId: user.restaurantId,
    branchId: ids && ids.length === 1 ? ids[0] : null,
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
            title="No transfers yet"
            description="Move stock between branches, a warehouse or the production house."
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
