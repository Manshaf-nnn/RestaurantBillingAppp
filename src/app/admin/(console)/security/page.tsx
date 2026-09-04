import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { getSecurityOverview } from '@/features/platform/ops-queries'
import { OpsTable, Stat, StatRow, StatusPill, ago } from '@/features/platform/components/ops-ui'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Security' }

/**
 * §14: RBAC, MFA on privileged accounts, sessions, rate limiting, audit.
 *
 * The headline is MFA coverage on privileged accounts, because that is the one
 * number here that an operator can move and that changes what an attacker with
 * a stolen password can do. Everything else on this page is a readout.
 */
export default async function SecurityPage() {
  await requirePageSuperAdmin('/admin/security')
  const security = await getSecurityOverview()

  return (
    <>
      <PageHeader
        title="Security"
        description="Multi-factor coverage, live sessions and the rate limiter."
      />

      <StatRow>
        <Stat
          label="MFA on privileged accounts"
          value={`${security.mfaCoveragePercent}%`}
          tone={security.mfaCoveragePercent === 100 ? 'ok' : security.mfaCoveragePercent >= 50 ? 'warn' : 'bad'}
          hint={`${security.privilegedWithMfa} of ${security.privilegedAccounts} super-admin, owner and admin accounts`}
        />
        <Stat label="Live sessions" value={security.activeSessions} />
        <Stat
          label="Expired sessions not cleared"
          value={security.expiredSessionsNotCleared}
          tone={security.expiredSessionsNotCleared > 500 ? 'warn' : 'idle'}
          hint="Harmless — an expired refresh token is refused whether or not the row is gone."
        />
        <Stat label="Sign-in events (24h)" value={security.loginEvents} />
      </StatRow>

      <OpsTable
        title="Rate limiter"
        description="Counters shared across every instance through Postgres, so a serverless host cannot count to one per invocation."
        columns={['Key', 'Hits', 'Window opened']}
        rows={security.rateLimited.map((row) => [
          <span key={row.key} className="font-mono text-xs">{row.key}</span>,
          String(row.count),
          ago(row.windowStart),
        ])}
        empty="No rate-limit activity in the last 24 hours."
      />

      <OpsTable
        title="Controls in force"
        columns={['Control', 'State']}
        rows={[
          ['Tenant isolation', <StatusPill key="t" tone="ok">restaurantId from the session only</StatusPill>],
          ['Branch scoping', <StatusPill key="b" tone="ok">fail-closed — an empty allow-list sees nothing</StatusPill>],
          ['Audit trail', <StatusPill key="a" tone="ok">append-only, enforced by database trigger</StatusPill>],
          ['Payment card data', <StatusPill key="p" tone="ok">never handled — no gateway in this system</StatusPill>],
          ['Secrets in logs', <StatusPill key="s" tone="ok">redacted before anything is written</StatusPill>],
        ]}
        empty=""
        footer="Roles and permissions are configured inside each restaurant; this page reports the platform-level controls only."
      />
    </>
  )
}
