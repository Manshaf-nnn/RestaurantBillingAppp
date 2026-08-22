import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { StartCountButton } from '@/features/inventory/components/start-count-button'
import { listStockCounts } from '@/features/inventory/count-queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock counts' }

const STATUS = {
  DRAFT: { label: 'Counting', variant: 'secondary' as const },
  AWAITING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' as const },
  APPROVED: { label: 'Approved', variant: 'success' as const },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' as const },
}

export default async function StockCountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.INVENTORY_COUNT,
    '/dashboard/inventory/counts',
  )
  // A stock count is a count of one location's shelves.
  const { branchIds } = await selectedBranch(user, await searchParams)
  const counts = await listStockCounts({ restaurantId: user.restaurantId, branchIds })

  return (
    <>
      <PageHeader
        title="Stock counts"
        description="Count the shelf, then have the difference approved. Counting never moves stock on its own."
        actions={<StartCountButton />}
      />

      <SectionCard title="Counts">
        {counts.length === 0 ? (
          <EmptyState
            title="No stock counts yet"
            description="Start one, walk the store, and enter what you find."
          />
        ) : (
          <ul className="divide-y divide-border">
            {counts.map((count) => {
              const status = STATUS[count.status]
              return (
                <li key={count.id}>
                  <Link
                    href={`/dashboard/inventory/counts/${count.id}`}
                    className="-mx-2 flex flex-wrap items-center gap-3 rounded-lg px-2 py-3 hover:bg-muted"
                  >
                    <span className="font-medium tabular-nums">{count.reference}</span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <span className="text-sm text-muted-foreground">
                      {count.lineCount} item{count.lineCount === 1 ? '' : 's'}
                    </span>
                    <span className="ml-auto text-sm text-muted-foreground">
                      <LocalDateTime value={count.countedAt} />
                      {count.countedByName ? ` · ${count.countedByName}` : ''}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>
    </>
  )
}
