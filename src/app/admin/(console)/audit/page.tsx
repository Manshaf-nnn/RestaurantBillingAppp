import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { listPlatformAudit } from '@/features/platform/ops-queries'
import { OpsTable, ago } from '@/features/platform/components/ops-ui'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Audit log' }

/**
 * Every sensitive action, across every tenant.
 *
 * A tenant-scoped audit view already existed at /dashboard/audit-logs; what did
 * not was a way for the platform operator to see across tenants, which is
 * exactly what an incident spanning two restaurants — or an allegation about
 * the operator's own staff — requires.
 *
 * There is no delete and no edit here, and there cannot be: a database trigger
 * refuses to let an audit row change at all (migration
 * 20260917093000_append_only_guards). A log an operator can tidy is not a log.
 */
export default async function PlatformAuditPage() {
  await requirePageSuperAdmin('/admin/audit')
  const entries = await listPlatformAudit({ take: 300 })

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Sensitive actions across every restaurant, newest first. Append-only — enforced by the database, not by convention."
      />
      <OpsTable
        title={`${entries.length} most recent entries`}
        columns={['When', 'Restaurant', 'Branch', 'Action', 'Entity', 'Who', 'IP']}
        rows={entries.map((entry) => [
          <span key={entry.id} title={entry.createdAt}>{ago(entry.createdAt)}</span>,
          entry.restaurantName ?? '—',
          entry.branchName ?? '—',
          <code key={`${entry.id}-a`} className="font-mono text-xs">{entry.action}</code>,
          entry.entityId ? `${entry.entity} ${entry.entityId.slice(-8)}` : entry.entity,
          entry.actorName ?? '—',
          entry.ipAddress ?? '—',
        ])}
        empty="Nothing audited yet."
      />
    </>
  )
}
