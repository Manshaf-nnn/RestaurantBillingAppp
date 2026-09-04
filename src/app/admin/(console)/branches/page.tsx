import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { listPlatformBranches } from '@/features/platform/ops-queries'
import { OpsTable, StatusPill } from '@/features/platform/components/ops-ui'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Branches' }

/**
 * Every branch on the platform, read-only.
 *
 * Read-only deliberately. A branch belongs to a restaurant and its shape —
 * which sites exist, which is the default, which is a warehouse — is an
 * operational decision the owner makes and the stock ledger depends on.
 * Renaming or deactivating one from here would change balances that the
 * restaurant is reconciling and could not explain. What the operator needs is
 * the ability to SEE the shape when a tenant reports a problem, which is this.
 */
export default async function PlatformBranchesPage() {
  await requirePageSuperAdmin('/admin/branches')
  const branches = await listPlatformBranches()

  return (
    <>
      <PageHeader
        title="Branches"
        description="Every site across every restaurant. Read-only — branch structure belongs to the restaurant that owns it."
      />
      <OpsTable
        title={`${branches.length} branches`}
        columns={['Restaurant', 'Branch', 'Code', 'Type', 'Orders', 'Staff', 'State']}
        rows={branches.map((branch) => [
          branch.restaurantName,
          <span key={branch.id}>
            {branch.name}
            {branch.isDefault ? <span className="ml-2 text-xs text-muted-foreground">default</span> : null}
          </span>,
          branch.code,
          branch.type.replace(/_/g, ' ').toLowerCase(),
          branch.orders.toLocaleString(),
          String(branch.users),
          <StatusPill key={`${branch.id}-s`} tone={branch.isActive ? 'ok' : 'idle'}>
            {branch.isActive ? 'Active' : 'Inactive'}
          </StatusPill>,
        ])}
        empty="No branches yet — a restaurant gets its first branch when it is approved."
        footer="Capped at 500 rows."
      />
    </>
  )
}
