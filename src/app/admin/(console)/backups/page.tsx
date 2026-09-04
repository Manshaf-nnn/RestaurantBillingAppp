import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { OpsTable, Stat, StatRow, StatusPill, ago, bytes } from '@/features/platform/components/ops-ui'
import { RecordRestoreTestControl } from '@/features/platform/components/ops-controls'
import { getNeonBackupStatus } from '@/server/backups/neon'
import { prisma } from '@/server/db/prisma'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Backups' }

/**
 * §10 Backups: last successful backup, status, history, retention, PITR,
 * last restore test and its result.
 *
 * ── The rule that shapes this whole page ────────────────────────────────────
 *
 * §10 is explicit: the application must not pretend to perform backups that the
 * database provider actually performs, and must never expose dangerous database
 * deletion controls. Neon owns the backups, the PITR window and the restore
 * machinery. So there is no "Back up now" button here, no "Restore" button, and
 * nothing that deletes — pressing a button on this page cannot change the state
 * of a single backup.
 *
 * What the page does is read the real state from Neon's API and show it, or say
 * plainly that it cannot. The one thing the application genuinely owns is the
 * record of somebody having tested a restore, because a backup nobody has ever
 * restored is a belief rather than a backup.
 */
export default async function BackupsPage() {
  await requirePageSuperAdmin('/admin/backups')

  const [neon, restoreTests] = await Promise.all([
    getNeonBackupStatus(),
    prisma.restoreTest.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ])

  const lastTest = restoreTests[0]
  const restores = (neon.branches ?? []).filter((branch) => branch.restoredFrom)

  return (
    <>
      <PageHeader
        title="Backups"
        description="Backups are performed by Neon, the database provider. This page reads their state; it cannot create or restore one."
      />

      {!neon.configured ? (
        <OpsTable
          title="Not connected to the provider"
          columns={['What to do']}
          rows={[[neon.reason ?? '']]}
          empty=""
          footer="Nothing above is a claim about whether backups are working — this application simply cannot see them yet."
        />
      ) : neon.error ? (
        <OpsTable
          title="Could not read the provider"
          columns={['What happened']}
          rows={[[neon.error]]}
          empty=""
          footer="Backups are not affected by this page failing to load. Check the Neon console directly."
        />
      ) : (
        <>
          <StatRow>
            <Stat
              label="Provider"
              value={<StatusPill tone="ok">Neon</StatusPill>}
              hint={`${neon.projectName ?? 'project'} · ${neon.regionId ?? ''}`}
            />
            <Stat
              label="Point-in-time recovery"
              value={neon.historyRetentionDays ? `${neon.historyRetentionDays} days` : 'none'}
              tone={neon.historyRetentionDays && neon.historyRetentionDays > 0 ? 'ok' : 'bad'}
              hint={
                neon.pitrOldest
                  ? `restorable back to ${new Date(neon.pitrOldest).toLocaleString()}`
                  : 'This plan retains no history — a mistake cannot be undone.'
              }
            />
            <Stat
              label="Last restore test"
              value={
                lastTest
                  ? <StatusPill tone={lastTest.outcome === 'PASSED' ? 'ok' : lastTest.outcome === 'PARTIAL' ? 'warn' : 'bad'}>
                      {lastTest.outcome.toLowerCase()}
                    </StatusPill>
                  : <StatusPill tone="bad">never</StatusPill>
              }
              hint={lastTest ? ago(lastTest.createdAt.toISOString()) : 'A backup nobody has restored is a belief, not a backup.'}
            />
            <Stat label="Branches" value={(neon.branches ?? []).length} hint={`${restores.length} created from a past moment`} />
          </StatRow>

          <OpsTable
            title="Database branches"
            description="Neon's branches. One created from a past timestamp is a point-in-time restore."
            columns={['Branch', 'Created', 'Size', 'Restored from', 'Flags']}
            rows={(neon.branches ?? []).map((branch) => [
              branch.name,
              ago(branch.createdAt),
              branch.logicalSizeBytes === null ? '—' : bytes(branch.logicalSizeBytes),
              branch.restoredFrom ? new Date(branch.restoredFrom).toLocaleString() : '—',
              [branch.isDefault ? 'default' : null, branch.isProtected ? 'protected' : null]
                .filter(Boolean)
                .join(', ') || '—',
            ])}
            empty="No branches reported."
          />
        </>
      )}

      <OpsTable
        title="Restore tests"
        description="The only part of backup health this application can honestly own: whether a person has proved a restore works."
        columns={['When', 'Target', 'Result', 'Tested by', 'Notes']}
        rows={restoreTests.map((test) => [
          <span key={test.id} title={test.createdAt.toISOString()}>{ago(test.createdAt.toISOString())}</span>,
          test.target,
          <StatusPill key={`${test.id}-o`} tone={test.outcome === 'PASSED' ? 'ok' : test.outcome === 'PARTIAL' ? 'warn' : 'bad'}>
            {test.outcome.toLowerCase()}
          </StatusPill>,
          test.testedByName ?? '—',
          test.notes ?? '—',
        ])}
        empty="No restore has ever been tested. Until one has been, the backups above are untested — see DISASTER-RECOVERY.md for the procedure."
        footer={<RecordRestoreTestControl />}
      />

      <OpsTable
        title="Logical dumps"
        columns={['What', 'Where it stands']}
        rows={[
          ['scripts/backup.ts', 'A pg_dump to local disk, intended for a VPS crontab. The serverless host has no persistent filesystem, so on this deployment it is something an operator runs by hand — not the backup strategy.'],
          ['Off-site copies', 'Not automated. The provider’s own backups above are the strategy; a dump is a convenience for moving data between environments.'],
        ]}
        empty=""
      />
    </>
  )
}
