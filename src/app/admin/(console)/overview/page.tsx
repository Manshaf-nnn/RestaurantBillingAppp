import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { getPlatformOverview } from '@/features/platform/ops-queries'
import { OpsTable, Stat, StatRow, StatusPill, bytes } from '@/features/platform/components/ops-ui'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Platform overview' }

/**
 * The §9 dashboard: is anything on fire, and where.
 *
 * Every figure §9 names, and nothing else. The temptation on a page like this
 * is a chart per metric; what an operator actually does with it is scan for the
 * one number that is the wrong colour, so the numbers are large and the
 * commentary is small.
 */
export default async function PlatformOverviewPage() {
  await requirePageSuperAdmin('/admin/overview')
  const overview = await getPlatformOverview()

  const dbTone = overview.database.status === 'ok'
    ? overview.database.latencyMs > 500 ? 'warn' : 'ok'
    : 'bad'

  /*
   * Realtime is "disabled" rather than "broken" when sockets are off, because
   * on the serverless host that is the intended configuration — screens poll
   * /api/pulse instead. Reporting a deliberate design as a fault would train an
   * operator to ignore this row.
   */
  const realtimeTone = overview.realtime.outboxAgeSeconds === null
    ? 'idle'
    : overview.realtime.outboxAgeSeconds > 3600 ? 'warn' : 'ok'

  return (
    <>
      <PageHeader
        title="Platform overview"
        description="System, database, realtime, jobs and storage — plus what the platform did in the last 24 hours."
      />

      <StatRow>
        <Stat
          label="System"
          value={<StatusPill tone={dbTone === 'bad' ? 'bad' : 'ok'}>{dbTone === 'bad' ? 'Degraded' : 'Healthy'}</StatusPill>}
          hint="Healthy means the database answers."
        />
        <Stat
          label="Database"
          value={<StatusPill tone={dbTone}>{overview.database.latencyMs}ms</StatusPill>}
          hint={`${bytes(overview.database.sizeBytes)} · ${overview.database.connections} connections`}
        />
        <Stat
          label="Realtime"
          value={
            <StatusPill tone={realtimeTone}>
              {overview.realtime.socketsReady ? 'Sockets' : 'Polling'}
            </StatusPill>
          }
          hint={`${overview.realtime.eventsLastHour} events in the last hour`}
        />
        <Stat
          label="Background jobs"
          value={overview.failedJobs}
          tone={overview.failedJobs > 0 ? 'bad' : 'idle'}
          hint={overview.failedJobs > 0 ? 'failed and not retrying' : 'none failed'}
        />
      </StatRow>

      <StatRow>
        <Stat
          label="Active restaurants"
          value={overview.restaurants.active}
          hint={`${overview.restaurants.pending} pending · ${overview.restaurants.suspended} suspended · ${overview.restaurants.trialing} on trial`}
        />
        <Stat
          label="Active users"
          value={overview.users.activeToday}
          hint={`of ${overview.users.total} accounts, signed in within 24h`}
        />
        <Stat
          label="Orders (24h)"
          value={overview.ordersToday}
          hint="Rolling 24 hours, not a local calendar day"
        />
        <Stat
          label="Critical errors (24h)"
          value={overview.criticalErrors}
          tone={overview.criticalErrors > 0 ? 'bad' : 'idle'}
          hint={<Link className="underline" href="/admin/errors">Open the error centre</Link>}
        />
      </StatRow>

      <OpsTable
        title="Storage"
        columns={['What', 'Amount']}
        rows={[
          ['Database', bytes(overview.database.sizeBytes)],
          ['Media (images in Postgres)', `${overview.storage.mediaCount} files · ${bytes(overview.storage.mediaBytes)}`],
          ['Redis cache', overview.redis ? 'Connected' : 'Not configured — Postgres counters in use'],
        ]}
        empty="No storage information."
        footer="Image bytes live in Postgres by design; they are included in the database size above."
      />
    </>
  )
}
