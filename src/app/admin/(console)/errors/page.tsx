import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { listPlatformErrors } from '@/features/platform/ops-queries'
import { OpsTable, Stat, StatRow, StatusPill, ago } from '@/features/platform/components/ops-ui'
import { ResolveErrorControl } from '@/features/platform/components/ops-controls'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Errors' }

/**
 * §12 Error centre: severity, time, operation, restaurant, branch, request id,
 * affected record, details — and safe investigation and resolution.
 *
 * ── Why this page now has anything on it ────────────────────────────────────
 *
 * `ErrorLog` existed and was nearly empty of the things that matter. Server
 * Actions — every mutation in the product — were caught by `runAction`, turned
 * into a friendly message and `console.error`'d, so the settle that would not
 * commit and the receipt that refused were never recorded anywhere durable.
 * Only exceptions escaping a render reached the table.
 *
 * Resolution is an annotation and never a deletion: what went wrong and what
 * was done about it are both worth keeping, and a centre where inconvenient
 * rows can be removed is a centre that shows its operator what they want.
 */
export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string; unresolved?: string }>
}) {
  await requirePageSuperAdmin('/admin/errors')
  const params = await searchParams

  const [errors, critical, unresolved] = await Promise.all([
    listPlatformErrors({
      severity: params.severity,
      unresolvedOnly: params.unresolved !== '0',
      take: 200,
    }),
    listPlatformErrors({ severity: 'CRITICAL', unresolvedOnly: true, take: 500 }),
    listPlatformErrors({ unresolvedOnly: true, take: 500 }),
  ])

  return (
    <>
      <PageHeader
        title="Errors"
        description="Everything that failed, across every restaurant. Unresolved first."
      />

      <StatRow>
        <Stat
          label="Critical, unresolved"
          value={critical.length}
          tone={critical.length > 0 ? 'bad' : 'idle'}
          hint="Integrity findings and exhausted jobs"
        />
        <Stat label="Unresolved" value={unresolved.length} tone={unresolved.length > 0 ? 'warn' : 'idle'} />
        <Stat label="Showing" value={errors.length} hint="Most recent 200" />
        <Stat
          label="Retention"
          value="90 days"
          hint="Resolved errors are trimmed; unresolved ones are kept."
        />
      </StatRow>

      <OpsTable
        title="Errors"
        columns={['When', 'Severity', 'Operation', 'Restaurant', 'Branch', 'Message', 'Request', 'Resolve']}
        rows={errors.map((error) => [
          <span key={error.id} title={error.createdAt}>{ago(error.createdAt)}</span>,
          <StatusPill
            key={`${error.id}-sev`}
            tone={error.severity === 'CRITICAL' ? 'bad' : error.severity === 'WARNING' ? 'warn' : 'idle'}
          >
            {error.severity.toLowerCase()}
          </StatusPill>,
          <span key={`${error.id}-op`} className="font-mono text-xs">
            {error.operation ?? error.route ?? error.kind}
          </span>,
          error.restaurantName ?? '—',
          error.branchName ?? '—',
          <span key={`${error.id}-m`} className="block max-w-md truncate" title={error.message}>
            {error.message}
          </span>,
          <span key={`${error.id}-r`} className="font-mono text-[11px] text-muted-foreground">
            {error.requestId ? error.requestId.slice(0, 8) : error.digest?.slice(0, 8) ?? '—'}
          </span>,
          error.resolvedAt
            ? <span key={`${error.id}-d`} className="text-xs text-muted-foreground">resolved</span>
            : <ResolveErrorControl key={`${error.id}-c`} errorId={error.id} />,
        ])}
        empty="Nothing unresolved. That is the good empty state — errors are recorded from every Server Action, so silence here means silence out there."
        footer="Secrets and payment details are never written here; everything recorded goes through the same redaction filter as the audit trail."
      />
    </>
  )
}
