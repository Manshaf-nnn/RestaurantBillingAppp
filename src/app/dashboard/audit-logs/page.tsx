import type { Metadata } from 'next'
import { ScrollText } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Audit log' }

export default async function AuditLogsPage() {
  const user = await requirePagePermission(PERMISSIONS.AUDIT_VIEW, '/dashboard/audit-logs')
  const [restaurant, logs] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.auditLog.findMany({
      where: { restaurantId: user.restaurantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { name: true } } },
    }),
  ])
  const locale = restaurant.locale === 'en' ? 'en-IN' : restaurant.locale

  return (
    <>
      <PageHeader title="Audit log" description="Every administrative action, recorded" />
      {logs.length === 0 ? (
        <EmptyState icon={<ScrollText />} title="No activity yet" description="Admin actions will be logged here." />
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
