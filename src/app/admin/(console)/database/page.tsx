import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { getDatabaseHealth } from '@/features/platform/ops-queries'
import { OpsTable, Stat, StatRow, StatusPill, bytes } from '@/features/platform/components/ops-ui'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Database health' }

/**
 * §11 Database health: status, CPU, memory, connections, storage, latency, slow queries.
 *
 * Two things this page deliberately does not do, both because §11 says so:
 * there is no arbitrary database editing, and there is nothing that deletes.
 * It is a readout. The most an operator can do here is read a number and go and
 * do something about it somewhere else.
 *
 * ── "CPU" and "memory" ──────────────────────────────────────────────────────
 *
 * §11 asks for both and Postgres exposes neither to a client — a connected
 * session cannot see the host's CPU or RSS. The choice was to invent something
 * plausible or to report what the database actually knows, and inventing a
 * number that an operator might act on during an incident is the worse of the
 * two. What is shown instead is the work the database is doing and its cache
 * hit ratio, which is the figure that actually predicts whether more load will
 * hurt, plus a plain note saying where the real host metrics live.
 */
export default async function DatabaseHealthPage() {
  await requirePageSuperAdmin('/admin/database')
  const health = await getDatabaseHealth()

  const connectionPressure = health.connections.max > 0
    ? Math.round((health.connections.total / health.connections.max) * 100)
    : 0

  return (
    <>
      <PageHeader
        title="Database health"
        description="What the database itself reports. Read-only by design — no editing, no deletion."
      />

      <StatRow>
        <Stat
          label="Status"
          value={<StatusPill tone={health.status === 'ok' ? 'ok' : 'bad'}>
            {health.status === 'ok' ? 'Answering' : 'Not answering'}
          </StatusPill>}
          hint={`${health.latencyMs}ms round trip`}
        />
        <Stat
          label="Connections"
          value={`${health.connections.total} / ${health.connections.max}`}
          tone={connectionPressure > 80 ? 'bad' : connectionPressure > 60 ? 'warn' : 'idle'}
          hint={`${health.connections.active} active · ${health.connections.idleInTransaction} idle in transaction`}
        />
        <Stat
          label="Cache hit ratio"
          value={`${health.cacheHitPercent}%`}
          tone={health.cacheHitPercent < 95 ? 'warn' : 'ok'}
          hint="Below ~95% means the working set no longer fits in memory"
        />
        <Stat label="Size" value={bytes(health.sizeBytes)} hint="Total, including indexes and image bytes" />
      </StatRow>

      {health.stuckMigrations.length > 0 ? (
        <OpsTable
          title="Migrations that never finished"
          description="A migration in this state means the deployed code may expect columns that do not exist."
          columns={['Migration']}
          rows={health.stuckMigrations.map((name) => [name])}
          empty=""
        />
      ) : null}

      <OpsTable
        title="Slowest queries"
        description="Ranked by mean execution time, from pg_stat_statements."
        columns={['Mean', 'Calls', 'Total', 'Query']}
        rows={health.slowest.map((row) => [
          `${row.meanMs}ms`,
          row.calls.toLocaleString(),
          `${Math.round(row.totalMs / 1000)}s`,
          <code key={row.query} className="font-mono text-xs">{row.query}</code>,
        ])}
        empty={
          health.slowQueriesAvailable
            ? 'No queries recorded yet — statistics reset when the database restarts.'
            : 'pg_stat_statements is not enabled on this database, so slow queries cannot be reported. It is on by default on Neon; on a local Postgres, add it to shared_preload_libraries and CREATE EXTENSION pg_stat_statements. This is an absent measurement, not an absence of slow queries.'
        }
      />

      <OpsTable
        title="Largest tables"
        columns={['Table', 'Size', 'Rows']}
        rows={health.biggestTables.map((table) => [
          table.name,
          bytes(table.bytes),
          table.rows.toLocaleString(),
        ])}
        empty="No table statistics available."
      />

      <OpsTable
        title="Work done"
        description="Postgres does not expose host CPU or memory to a client. These are what it does report."
        columns={['Measure', 'Value']}
        rows={[
          ['Transactions committed', health.work.commits.toLocaleString()],
          ['Transactions rolled back', health.work.rollbacks.toLocaleString()],
          ['Blocks served from cache', health.work.blocksFromCache.toLocaleString()],
          ['Blocks read from disk', health.work.blocksFromDisk.toLocaleString()],
          ['Migrations applied', String(health.migrationsApplied)],
        ]}
        empty="No statistics available."
        footer="For host CPU and memory, see the database provider's own console — this application cannot measure them and does not pretend to."
      />
    </>
  )
}
