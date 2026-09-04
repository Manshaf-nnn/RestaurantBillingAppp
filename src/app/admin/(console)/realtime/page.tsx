import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { OpsTable, Stat, StatRow, StatusPill, ago } from '@/features/platform/components/ops-ui'
import { isRealtimeReady } from '@/server/realtime/emitter'
import { outboxAgeSeconds } from '@/server/realtime/outbox'
import { prisma } from '@/server/db/prisma'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Realtime' }

/**
 * Is the live channel carrying anything, and can it lose an order?
 *
 * ── What "Polling" means here, and why it is not a fault ────────────────────
 *
 * Socket.IO exists in this codebase and is switched off in production, because
 * the serverless host has no always-on process to hold a websocket. Screens
 * poll `/api/pulse` instead. That is the intended configuration, so this page
 * reports it as the mode it is rather than as a degradation — an operator who
 * is told the system is broken every day stops reading the page.
 *
 * The number that DOES matter is the outbox: every order, payment and stock
 * movement writes its event inside the same transaction as the work itself, so
 * a long gap since the newest event on a busy platform means screens are not
 * being told about things that happened.
 */
export default async function RealtimePage() {
  await requirePageSuperAdmin('/admin/realtime')

  const hourAgo = new Date(Date.now() - 3_600_000)
  const dayAgo = new Date(Date.now() - 86_400_000)

  const [age, lastHour, lastDay, byType, newest, oldest] = await Promise.all([
    outboxAgeSeconds(),
    prisma.outboxEvent.count({ where: { createdAt: { gte: hourAgo } } }),
    prisma.outboxEvent.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.outboxEvent.groupBy({
      by: ['type'],
      where: { createdAt: { gte: dayAgo } },
      _count: { _all: true },
    }),
    prisma.outboxEvent.findFirst({ orderBy: { seq: 'desc' }, select: { createdAt: true, type: true } }),
    prisma.outboxEvent.findFirst({ orderBy: { seq: 'asc' }, select: { createdAt: true } }),
  ])

  const tone = age === null ? 'idle' : age > 3600 ? 'warn' : 'ok'

  return (
    <>
      <PageHeader
        title="Realtime"
        description="How live updates reach screens, and whether the event log is keeping up."
      />

      <StatRow>
        <Stat
          label="Transport"
          value={<StatusPill tone="ok">{isRealtimeReady() ? 'WebSockets' : 'Polling'}</StatusPill>}
          hint={isRealtimeReady()
            ? 'Socket.IO is attached to this process.'
            : 'By design on serverless: screens poll /api/pulse. Not a fault.'}
        />
        <Stat
          label="Newest event"
          value={<StatusPill tone={tone}>{age === null ? 'None' : `${age}s ago`}</StatusPill>}
          hint={newest ? newest.type : 'The outbox is empty.'}
        />
        <Stat label="Events (1h)" value={lastHour.toLocaleString()} />
        <Stat
          label="Events (24h)"
          value={lastDay.toLocaleString()}
          hint={oldest ? `retained since ${ago(oldest.createdAt.toISOString())}` : undefined}
        />
      </StatRow>

      <OpsTable
        title="Events in the last 24 hours"
        description="Each row is written inside the same transaction as the order, payment or movement it describes — so a realtime failure cannot lose one."
        columns={['Event', 'Count']}
        rows={byType
          .sort((a, b) => b._count._all - a._count._all)
          .map((row) => [row.type, row._count._all.toLocaleString()])}
        empty="No events in the last 24 hours — expected on a quiet platform, and expected on a fresh install."
        footer="Trimmed after 7 days by the outbox-trim job. The orders, payments and movements themselves are kept for ever; this is the delivery log."
      />
    </>
  )
}
