import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { listPlatformUsers } from '@/features/platform/ops-queries'
import { OpsTable, StatusPill, ago } from '@/features/platform/components/ops-ui'
import { UserStateControl } from '@/features/platform/components/ops-controls'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Users' }

/**
 * Every account on the platform.
 *
 * ── What an operator can do here, and what they deliberately cannot ─────────
 *
 * They can stop an account and end its live sessions. They cannot set anybody's
 * password, and that absence is the important design decision on this page: an
 * operator who can set a restaurant owner's password can sign in as them, and
 * an account that can sign in as an owner can move that restaurant's money
 * while leaving an audit trail that names the owner. Password resets belong to
 * the owner, for their own staff.
 *
 * Deactivating revokes sessions as well as flipping the flag — otherwise the
 * account carries on working on a valid access token for up to an hour, which
 * is exactly the window somebody is trying to close.
 */
export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const admin = await requirePageSuperAdmin('/admin/users')
  const params = await searchParams
  const users = await listPlatformUsers({ query: params.q, take: 300 })

  return (
    <>
      <PageHeader
        title="Users"
        description="Every account across every restaurant. Stop an account or end its sessions — passwords stay with the restaurant."
      />
      <OpsTable
        title={`${users.length} accounts`}
        columns={['Name', 'Email', 'Restaurant', 'Role', 'Branch', 'MFA', 'Last seen', 'State', '']}
        rows={users.map((user) => [
          user.name,
          <span key={user.id} className="font-mono text-xs">{user.email}</span>,
          user.restaurantName ?? <span className="text-muted-foreground">platform</span>,
          user.role.replace(/_/g, ' ').toLowerCase(),
          user.branchName ?? '—',
          <StatusPill key={`${user.id}-m`} tone={user.mfaEnabled ? 'ok' : 'idle'}>
            {user.mfaEnabled ? 'on' : 'off'}
          </StatusPill>,
          ago(user.lastLoginAt),
          <StatusPill key={`${user.id}-s`} tone={user.isActive ? 'ok' : 'bad'}>
            {user.isActive ? 'active' : 'stopped'}
          </StatusPill>,
          user.id === admin.id
            ? <span key={`${user.id}-y`} className="text-xs text-muted-foreground">you</span>
            : <UserStateControl key={`${user.id}-c`} userId={user.id} isActive={user.isActive} />,
        ])}
        empty="No accounts match."
        footer="Deactivating an account also ends every session it holds, so access stops immediately rather than when the token expires."
      />
    </>
  )
}
