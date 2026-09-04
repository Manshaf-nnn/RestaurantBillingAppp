import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { OpsTable, StatusPill } from '@/features/platform/components/ops-ui'
import { MaintenanceControl } from '@/features/platform/components/ops-controls'
import { readMaintenance } from '@/features/platform/maintenance'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Maintenance' }

/**
 * A notice on every tenant's screen, and nothing more.
 *
 * ── Why this does not take the site down ────────────────────────────────────
 *
 * A maintenance mode that blocks writes sounds more useful and is worse. A
 * restaurant mid-service that suddenly cannot settle a bill has a queue at the
 * till and a guest holding a card, and no explanation an operator can give
 * makes that better than whatever the maintenance was for. Taking the site down
 * is the hosting platform's job, where it belongs, and where it is obvious that
 * it has been done.
 *
 * So this publishes a banner. It is honest, it is reversible in one click, and
 * it cannot cost anybody a service.
 */
export default async function MaintenancePage() {
  await requirePageSuperAdmin('/admin/maintenance')
  const maintenance = await readMaintenance()

  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Show every restaurant a notice. This does not stop trading — deliberately."
      />

      <OpsTable
        title="Notice"
        columns={['State', 'Message']}
        rows={[[
          <StatusPill key="s" tone={maintenance.enabled ? 'warn' : 'idle'}>
            {maintenance.enabled ? 'Showing' : 'Hidden'}
          </StatusPill>,
          maintenance.message || <span className="text-muted-foreground">no message set</span>,
        ]]}
        empty=""
        footer={<MaintenanceControl enabled={maintenance.enabled} message={maintenance.message} />}
      />

      <OpsTable
        title="What this does and does not do"
        columns={['', '']}
        rows={[
          ['Shows a banner to every signed-in user', 'yes'],
          ['Blocks orders, payments or stock movements', 'no — a till mid-service must keep working'],
          ['Takes the site offline', 'no — do that at the hosting platform, where it is visible'],
          ['Affects guest ordering', 'no'],
        ]}
        empty=""
      />
    </>
  )
}
