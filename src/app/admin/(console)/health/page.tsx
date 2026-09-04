import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { getPlatformOverview } from '@/features/platform/ops-queries'
import { OpsTable, Stat, StatRow, StatusPill, bytes } from '@/features/platform/components/ops-ui'
import { buildInfo } from '@/lib/build-info'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'System health' }

/**
 * What is running, and which build it is.
 *
 * The build commit is the point of this page. "Did my fix reach the site" is
 * the question an operator asks most often during an incident and the hardest
 * one to answer from the outside, and a version string that reads 1.0.0 on
 * every deploy — which is what this used to be — cannot answer it.
 */
export default async function SystemHealthPage() {
  await requirePageSuperAdmin('/admin/health')
  const [overview, build] = await Promise.all([getPlatformOverview(), Promise.resolve(buildInfo())])

  return (
    <>
      <PageHeader
        title="System health"
        description="Dependencies, and exactly which build is serving this page."
      />

      <StatRow>
        <Stat
          label="Database"
          value={<StatusPill tone={overview.database.status === 'ok' ? 'ok' : 'bad'}>
            {overview.database.status === 'ok' ? 'OK' : 'Error'}
          </StatusPill>}
          hint={`${overview.database.latencyMs}ms · ${bytes(overview.database.sizeBytes)}`}
        />
        <Stat
          label="Realtime"
          value={<StatusPill tone="ok">{overview.realtime.socketsReady ? 'Sockets' : 'Polling'}</StatusPill>}
          hint={`${overview.realtime.eventsLastHour} events in the last hour`}
        />
        <Stat
          label="Cache"
          value={<StatusPill tone={overview.redis ? 'ok' : 'idle'}>
            {overview.redis ? 'Redis' : 'Postgres'}
          </StatusPill>}
          hint={overview.redis ? 'Redis is connected.' : 'No REDIS_URL — rate limits use Postgres counters, which is shared and correct, just slower.'}
        />
        <Stat
          label="Failed jobs"
          value={overview.failedJobs}
          tone={overview.failedJobs > 0 ? 'bad' : 'idle'}
        />
      </StatRow>

      <OpsTable
        title="This build"
        columns={['', '']}
        rows={[
          ['Commit', build.commit ?? 'unknown — built outside CI'],
          ['Branch', build.branch ?? '—'],
          ['Built at', build.builtAt ?? '—'],
          ['Local build', build.local ? 'yes' : 'no'],
        ]}
        empty="No build information."
        footer="The public probe at /api/health returns the same information without authentication, for uptime monitors."
      />
    </>
  )
}
