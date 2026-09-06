import type { Metadata } from 'next'
import { ScrollText } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { SearchBox } from '@/components/search-box'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Audit log' }

export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.AUDIT_VIEW, '/dashboard/audit-logs')
  const params = await searchParams
  const search = (typeof params.search === 'string' ? params.search : '').trim()
  const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })

  const [restaurant, logs] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.auditLog.findMany({
      where: {
        restaurantId: user.restaurantId,
        /*
         * Two clauses, ANDed, because each is an OR of its own and side-by-side
         * they would overwrite one another on the same key.
         */
        AND: [
          /*
           * ── Whose actions this person may read ────────────────────────────
           *
           * This filtered on the restaurant and nothing else, and `AUDIT_VIEW`
           * is held by MANAGER — so an assigned branch manager read the whole
           * group's trail: every other site's refunds, price changes, role
           * grants and sign-ins.
           *
           * Scoped on the entry's branch OR the actor's, and the second half is
           * what makes it usable. `AuditLog.branchId` is nullable and most
           * `audit()` calls never pass one, so filtering on the column alone
           * would hide nearly everything including the reader's own team. Who
           * did it is the fact that is always recorded.
           *
           * An owner's settings change stays hidden from a branch manager —
           * an owner belongs to no branch, which is the correct answer for a
           * business-level action.
           */
          reach
            ? {
                OR: [
                  { branchId: { in: reach } },
                  { user: { is: { branchId: { in: reach } } } },
                ],
              }
            : {},
          /*
           * Searched in the query, not filtered after `take: 200`. This table is
           * the one that grows fastest in the whole app — a client filter over
           * the newest two hundred rows would confidently report "nothing found"
           * for the action you are actually looking for, which is exactly when
           * someone is reading an audit log.
           */
          search
            ? {
                OR: [
                  { action: { contains: search, mode: 'insensitive' } },
                  { entity: { contains: search, mode: 'insensitive' } },
                  { entityId: { contains: search, mode: 'insensitive' } },
                  { actorName: { contains: search, mode: 'insensitive' } },
                  { user: { is: { name: { contains: search, mode: 'insensitive' } } } },
                  { ipAddress: { contains: search, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { name: true } } },
    }),
  ])
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every administrative action, recorded. The newest 200 matching rows."
      />

      <div className="mb-4 max-w-sm">
        <SearchBox placeholder="Action, who, entity, record id or IP…" defaultValue={search} />
      </div>

      {logs.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title={search ? `Nothing matches “${search}”` : 'No activity yet'}
          description={
            search
              ? 'Try part of an action name, a person, or the id of the record you are tracing.'
              : 'Admin actions will be logged here.'
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden md:table-cell">Entity</TableHead>
                <TableHead className="hidden lg:table-cell">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="text-sm font-medium">{log.user?.name ?? log.actorName ?? 'System'}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{log.action}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {log.entity}
                    {log.entityId ? ` · ${log.entityId.slice(-6)}` : ''}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                    {log.ipAddress ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}
