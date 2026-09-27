import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate } from '@/lib/datetime'
import { publicNeonConfig, readNeonConfig, readNeonStatus } from '@/server/neon/config'
import { describeDatabaseUrl } from '@/server/neon/monitor'
import type { NeonAlertLevel } from '@/server/neon/types'

import { NeonPanel } from './neon-panel'
import { Stat, StatRow, StatusPill, ago, bytes, type Tone } from './ops-ui'

/**
 * The provider's view of the production database, on the Database page.
 *
 * Everything shown is the last snapshot the hourly watcher stored — see
 * `src/server/neon/monitor.ts` — so this renders instantly and never blocks
 * the page on Neon's API. "Check now" refreshes it on demand.
 */

const ALERT_TONE: Record<NeonAlertLevel, Tone> = { critical: 'bad', warning: 'warn', info: 'idle' }
const ALERT_LABEL: Record<NeonAlertLevel, string> = { critical: 'Critical', warning: 'Warning', info: 'Note' }

function hours(value: number): string {
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} h`
}

export async function NeonSection({ adminEmail }: { adminEmail: string }) {
  const [config, status] = await Promise.all([readNeonConfig(), readNeonStatus()])
  const view = publicNeonConfig(config)
  const connection = describeDatabaseUrl()
  const snapshot = status?.snapshot ?? null
  const project = snapshot?.project ?? null
  const alerts = status?.alerts ?? []
  const writer = snapshot?.endpoints.find((endpoint) => endpoint.type === 'read_write') ?? null

  const daysLeft = project?.periodEnd
    ? Math.ceil((new Date(project.periodEnd).getTime() - Date.now()) / 86_400_000)
    : null
  const retentionHours = project ? Math.round(project.historyRetentionSeconds / 3600) : 0

  const endpointTone: Tone = !writer ? 'idle' : writer.disabled ? 'bad' : writer.currentState === 'active' ? 'ok' : 'idle'
  const endpointLabel = !writer
    ? 'No endpoint'
    : writer.disabled
      ? 'Disabled'
      : writer.currentState === 'active'
        ? 'Active'
        : writer.currentState === 'idle'
          ? 'Idle'
          : writer.currentState

  return (
    <section className="mt-10 space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Neon</h2>
        <p className="text-sm text-muted-foreground">
          The provider that runs this database. Watched every hour once connected: usage against
          limits, the endpoint, the invoice date, and whether the app is pointed at the project being
          watched.
        </p>
      </div>

      {connection ? (
        <Card>
          <CardHeader>
            <CardTitle>What the app is connected to</CardTitle>
            <CardDescription>
              Read from DATABASE_URL on the server. These are the facts to match against the Neon
              console; the password is held by the app and never shown. Migrations use the same host
              without “-pooler”. Neon&apos;s AI Gateway, Auth and Data API are not used by TableFlow and
              need no setup.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-4 border-b py-1.5"><dt className="text-muted-foreground">Provider</dt><dd>{connection.neon ? 'Neon' : 'Postgres (not Neon)'}</dd></div>
              <div className="flex justify-between gap-4 border-b py-1.5"><dt className="text-muted-foreground">Region</dt><dd>{connection.region ?? '—'}</dd></div>
              <div className="flex justify-between gap-4 border-b py-1.5"><dt className="text-muted-foreground">Role</dt><dd className="font-mono text-xs">{connection.role ?? '—'}</dd></div>
              <div className="flex justify-between gap-4 border-b py-1.5"><dt className="text-muted-foreground">Database</dt><dd className="font-mono text-xs">{connection.database ?? '—'}</dd></div>
              <div className="flex justify-between gap-4 border-b py-1.5 sm:col-span-2"><dt className="text-muted-foreground">Endpoint</dt><dd className="truncate font-mono text-xs">{connection.host ?? '—'}</dd></div>
              <div className="flex justify-between gap-4 py-1.5"><dt className="text-muted-foreground">Pooled</dt><dd>{connection.pooled ? 'Yes, as production should be' : 'No — production should use the “-pooler” host'}</dd></div>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {view.configured && snapshot ? (
        <>
          <StatRow>
            <Stat
              label="Project"
              value={project?.name ?? '—'}
              hint={
                project
                  ? [project.regionId, project.pgVersion ? `Postgres ${project.pgVersion}` : null, project.plan ? `${project.plan} plan` : null]
                      .filter(Boolean)
                      .join(' · ')
                  : snapshot.api.ok
                    ? 'No project selected yet'
                    : (snapshot.api.error ?? 'Neon did not answer')
              }
              tone={snapshot.api.ok ? 'idle' : 'bad'}
            />
            <Stat
              label="Compute this period"
              value={project ? hours(project.computeHours) : '—'}
              hint={project?.periodStart ? `Compute-unit hours since ${formatDate(project.periodStart)}` : undefined}
              tone={
                project && config.budgets.computeHours
                  ? project.computeHours >= config.budgets.computeHours
                    ? 'bad'
                    : project.computeHours >= 0.8 * config.budgets.computeHours
                      ? 'warn'
                      : 'idle'
                  : 'idle'
              }
            />
            <Stat label="Storage" value={project ? bytes(project.storageBytes) : '—'} hint="What Neon bills for, including history" />
            <Stat label="Data transfer" value={project ? bytes(project.transferBytes) : '—'} hint="Out of Neon to the app, this period" />
            <Stat
              label="Next invoice"
              value={daysLeft === null ? '—' : daysLeft <= 0 ? 'Today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'}`}
              hint={project?.periodEnd ? `Period closes ${formatDate(project.periodEnd)}; the card on file is charged then` : undefined}
              tone={daysLeft !== null && daysLeft <= config.reminderDaysBefore ? 'warn' : 'idle'}
            />
            <Stat
              label="Endpoint"
              value={<StatusPill tone={endpointTone}>{endpointLabel}</StatusPill>}
              hint={
                writer
                  ? `${writer.minCu ?? '?'}–${writer.maxCu ?? '?'} CU · ${writer.host}`
                  : undefined
              }
            />
            <Stat
              label="Recovery window"
              value={project ? (retentionHours >= 48 ? `${Math.round(retentionHours / 24)} d` : `${retentionHours} h`) : '—'}
              hint="How far back a point-in-time restore can reach"
              tone={project && retentionHours < 24 ? 'warn' : 'idle'}
            />
            <Stat
              label="Last check"
              value={ago(snapshot.checkedAt)}
              hint={
                snapshot.app.ok
                  ? `App round trip ${snapshot.app.latencyMs ?? '?'} ms · ${snapshot.app.host ?? 'host unknown'}`
                  : `App cannot reach its database: ${snapshot.app.error ?? 'no answer'}`
              }
              tone={snapshot.app.ok ? 'ok' : 'bad'}
            />
          </StatRow>

          <Card>
            <CardHeader>
              <CardTitle>{alerts.length ? `${alerts.length} thing${alerts.length === 1 ? '' : 's'} to know` : 'Nothing to report'}</CardTitle>
              <CardDescription>
                {alerts.length
                  ? 'Warnings and critical items are also logged under Errors and emailed once, then again only if they persist.'
                  : 'Usage is within limits, the endpoint is enabled, the app is connected to this project, and no invoice is imminent.'}
              </CardDescription>
            </CardHeader>
            {alerts.length ? (
              <CardContent>
                <ul className="space-y-3">
                  {alerts.map((alert) => (
                    <li key={alert.key} className="flex gap-3">
                      <StatusPill tone={ALERT_TONE[alert.level]}>{ALERT_LABEL[alert.level]}</StatusPill>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{alert.title}</div>
                        <div className="text-sm text-muted-foreground">{alert.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            ) : null}
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Not watched yet</CardTitle>
            <CardDescription>
              On 27 September 2026 the database went quiet because its Neon project had used up a
              monthly allowance, and nothing here noticed until a restaurant could not sign in.
              Connect an API key below and the platform checks every hour, warns before a limit is
              reached, and reminds you before each invoice.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <NeonPanel config={view} projects={snapshot?.projects ?? []} adminEmail={adminEmail} />
    </section>
  )
}
