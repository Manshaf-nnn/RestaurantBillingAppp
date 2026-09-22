'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarClock, Play } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { LocalDateTime, LocalTime } from '@/components/local-time'
import { SearchBox } from '@/components/search-box'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  HandoverDetailsDialog,
  HandoverHistoryTable,
  ShiftHandoverPanel,
} from '@/features/handover/components/shift-handover'
import type { ShiftHandoverView } from '@/features/handover/shift-types'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cancelShiftHandoverAction } from '@/features/handover/shift-actions'
import { startAssignedShiftAction } from '../actions'
import type { ShiftPanelData } from '../panel-data'
import type { CurrentShiftView, ShiftHistoryRow } from '../types'

/**
 * The Shift tab (shifthandover.md "UI"), top to bottom:
 *
 *   Current shift — what you are on, who else is, your till, your handover,
 *                   what is still to do; and the prompt to start the shift
 *                   you were rostered on (a prompt, never a gate).
 *   Handover      — the existing flow, unchanged in its guards.
 *   History       — shifts and handovers, searchable and filterable.
 *
 * Mounted at two doors — the dashboard and the POS — from one loader, so it
 * is one tab wherever it is opened.
 */

const SHIFT_STATUS: Record<CurrentShiftView['status'], { label: string; variant: 'success' | 'warning' | 'secondary' | 'info' }> = {
  ON_SHIFT: { label: 'On shift', variant: 'success' },
  NOT_STARTED: { label: 'Not started', variant: 'warning' },
  UNSCHEDULED: { label: 'Working — unscheduled', variant: 'info' },
  OFF: { label: 'Off shift', variant: 'secondary' },
}

export function ShiftPanel({
  data,
  viewerId,
  viewerName,
  currency,
  locale,
}: {
  data: ShiftPanelData
  viewerId: string
  viewerName: string
  currency: string
  locale: string
}) {
  const router = useRouter()
  const [starting, setStarting] = React.useState<string | null>(null)
  const [details, setDetails] = React.useState<ShiftHandoverView | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const money = (minor: number) => formatMoney(minor, currency, locale)
  const { current } = data

  const start = async (assignmentId: string) => {
    setStarting(assignmentId)
    const result = await callAction(() => startAssignedShiftAction({ assignmentId }))
    setStarting(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('You are on shift.')
    router.refresh()
  }

  const cancel = async (row: ShiftHandoverView) => {
    setBusy(row.id)
    const result = await callAction(() => cancelShiftHandoverAction({ handoverId: row.id }))
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Withdrawn.')
    router.refresh()
  }

  const status = SHIFT_STATUS[current.status]
  const pending = current.pending
  const chips = [
    [pending.openOrders, 'open order', 'open orders'],
    [pending.openTasks, 'open task', 'open tasks'],
    [pending.transfersToDispatch, 'transfer to dispatch', 'transfers to dispatch'],
    [pending.transfersToReceive, 'transfer to receive', 'transfers to receive'],
    [pending.deliveriesToReceive, 'delivery to receive', 'deliveries to receive'],
    [pending.notes, 'note for the next shift', 'notes for the next shift'],
  ] as const

  return (
    <div className="space-y-6">
      <SectionCard
        title="Current shift"
        description={`${current.branchName} · ${viewerName}`}
        actions={<Badge variant={status.variant} data-testid="shift-status">{status.label}</Badge>}
      >
        {current.toStart.length > 0 ? (
          <div className="mb-4 space-y-2" data-testid="shift-prompt">
            {current.toStart.map((row) => (
              <Alert key={row.id} variant="info" title={`You are rostered on the ${row.templateName} shift`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span>
                    <LocalTime value={row.scheduledStartAt} />–<LocalTime value={row.scheduledEndAt} /> at {row.branchName}
                  </span>
                  <Button size="sm" className="ml-auto" loading={starting === row.id} onClick={() => start(row.id)}>
                    <Play className="mr-1 h-4 w-4" /> Start this shift
                  </Button>
                </div>
              </Alert>
            ))}
          </div>
        ) : null}

        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Shift">
            {current.session?.templateName ?? (current.session ? 'Unscheduled' : '—')}
          </Tile>
          <Tile label="Scheduled">
            {current.session?.scheduledStartAt && current.session.scheduledEndAt ? (
              <>
                <LocalTime value={current.session.scheduledStartAt} />–<LocalTime value={current.session.scheduledEndAt} />
              </>
            ) : (
              '—'
            )}
          </Tile>
          <Tile label="Started">{current.session ? <LocalDateTime value={current.session.clockInAt} /> : '—'}</Tile>
          <Tile label="Cash drawer">
            {current.drawer.status === 'NONE' ? (
              <span className="text-muted-foreground">No drawer open</span>
            ) : (
              <>
                <Badge variant={current.drawer.status === 'OPEN' ? 'success' : 'warning'} size="sm">
                  {current.drawer.status === 'OPEN' ? 'Open' : 'Pending review'}
                </Badge>{' '}
                <span className="text-muted-foreground">
                  {current.drawer.sessionNumber}{current.drawer.registerName ? ` · ${current.drawer.registerName}` : ''}
                </span>
              </>
            )}
          </Tile>
          <Tile label="Handover">
            {current.handover.status === 'NONE' ? (
              <span className="text-muted-foreground">None in progress</span>
            ) : current.handover.status === 'WAITING_ON_THEM' ? (
              <>
                <Badge variant="warning" size="sm">Pending acceptance</Badge> <span className="text-muted-foreground">by {current.handover.withName}</span>
              </>
            ) : (
              <>
                <Badge variant="info" size="sm">Waiting on you</Badge> <span className="text-muted-foreground">from {current.handover.withName}</span>
              </>
            )}
          </Tile>
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 sm:col-span-2 lg:col-span-3">
            <dt className="text-xs text-muted-foreground">Pending responsibilities</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5" data-testid="shift-pending">
              {chips.every(([n]) => n === 0) ? (
                <span className="text-sm text-muted-foreground">Nothing outstanding.</span>
              ) : (
                chips
                  .filter(([n]) => n > 0)
                  .map(([n, one, many]) => (
                    <Badge key={many} variant="outline">{n} {n === 1 ? one : many}</Badge>
                  ))
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Assigned staff today ({current.assignedStaff.length})
          </p>
          {current.assignedStaff.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is rostered here today.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm" data-testid="assigned-staff">
              {current.assignedStaff.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  <span className="font-medium">{row.name}</span>
                  <span className="text-muted-foreground">{row.roleLabel} · {row.templateName}</span>
                  <span className="text-muted-foreground">
                    <LocalTime value={row.scheduledStartAt} />–<LocalTime value={row.scheduledEndAt} />
                  </span>
                  <span className="ml-auto">
                    {row.working ? (
                      <Badge variant="success" size="sm">On shift</Badge>
                    ) : row.status === 'COMPLETED' ? (
                      <Badge variant="secondary" size="sm">Done</Badge>
                    ) : row.status === 'STARTED' ? (
                      <Badge variant="info" size="sm">Started</Badge>
                    ) : (
                      <Badge variant="outline" size="sm">Planned</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionCard>

      <ShiftHandoverPanel
        viewerId={viewerId}
        viewerName={viewerName}
        waiting={data.waiting}
        mine={data.mine}
        history={[]}
        canCancelOthers={data.canSeeAll}
        currency={currency}
        locale={locale}
        branchId={data.branchId}
        showHistory={false}
      />

      <SectionCard
        title="History"
        description={data.canSeeAll ? 'Every shift and handover at this location.' : 'Your shifts and your handovers.'}
      >
        <HistoryFilters data={data} />

        <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Shift history ({data.shiftHistory.length})
        </p>
        <ShiftHistoryTable rows={data.shiftHistory} />

        <p className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Handover history ({data.handovers.length})
        </p>
        <HandoverHistoryTable
          rows={data.handovers}
          viewerId={viewerId}
          mineId={data.mine?.id ?? null}
          canCancelOthers={data.canSeeAll}
          busy={busy}
          money={money}
          onDetails={setDetails}
          onCancel={cancel}
        />
      </SectionCard>

      <HandoverDetailsDialog row={details} onClose={() => setDetails(null)} currency={currency} locale={locale} />
    </div>
  )
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold">{children}</dd>
    </div>
  )
}

/* ── filters: state in the URL, so the server does the narrowing ────────── */

export function HistoryFilters({ data }: { data: Pick<ShiftPanelData, 'filters' | 'staffOptions' | 'templateOptions' | 'canSeeAll'> }) {
  const router = useRouter()
  const params = useSearchParams()
  const { filters } = data

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    router.replace(`?${next.toString()}`)
  }

  const select = 'h-9 rounded-lg border border-input bg-background px-2 text-sm'

  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="history-filters">
      <SearchBox placeholder="Search by name…" paramName="q" defaultValue={filters.q} className="w-full sm:w-56" />
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="sh-from">From</label>
        <Input id="sh-from" type="date" className="h-9 w-40" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="sh-to">To</label>
        <Input id="sh-to" type="date" className="h-9 w-40" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
      </div>
      {data.canSeeAll && data.staffOptions.length > 0 ? (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="sh-staff">Staff</label>
          <select id="sh-staff" className={select} value={filters.staff} onChange={(e) => set({ staff: e.target.value })}>
            <option value="">Everyone</option>
            {data.staffOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      ) : null}
      {data.templateOptions.length > 0 ? (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="sh-shift">Shift</label>
          <select id="sh-shift" className={select} value={filters.shift} onChange={(e) => set({ shift: e.target.value })}>
            <option value="">Any shift</option>
            {data.templateOptions.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="sh-status">Handover</label>
        <select id="sh-status" className={select} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Any status</option>
          <option value="PENDING_ACCEPTANCE">Pending acceptance</option>
          <option value="COMPLETED">Completed</option>
          <option value="REJECTED">Rejected</option>
          <option value="CANCELLED">Withdrawn</option>
        </select>
      </div>
      {filters.q || filters.from || filters.to || filters.staff || filters.shift || filters.status ? (
        <Button variant="ghost" size="sm" onClick={() => set({ q: '', from: '', to: '', staff: '', shift: '', status: '' })}>
          Clear
        </Button>
      ) : null}
    </div>
  )
}

export function ShiftHistoryTable({ rows }: { rows: ShiftHistoryRow[] }) {
  if (rows.length === 0) {
    return <EmptyState icon={<CalendarClock />} title="No shifts in this period" description="A shift starts when somebody signs in or starts the one they were rostered on." />
  }
  return (
    <div className="-mx-2 overflow-x-auto px-2">
      <table className="w-full min-w-[44rem] text-sm" data-testid="shift-history">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">Date</th>
            <th className="pb-2 pr-3 font-medium">Staff</th>
            <th className="pb-2 pr-3 font-medium">Location</th>
            <th className="pb-2 pr-3 font-medium">Shift</th>
            <th className="pb-2 pr-3 font-medium">Scheduled</th>
            <th className="pb-2 pr-3 font-medium">Actual</th>
            <th className="pb-2 pr-3 font-medium">Hours</th>
            <th className="pb-2 font-medium">Ended by</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="py-2 pr-3 text-muted-foreground">{row.date}</td>
              <td className="py-2 pr-3">
                {row.userName} <span className="text-xs text-muted-foreground">{row.roleLabel}</span>
              </td>
              <td className="py-2 pr-3">{row.branchName}</td>
              <td className="py-2 pr-3">{row.templateName ?? <span className="text-muted-foreground">Unscheduled</span>}</td>
              <td className="py-2 pr-3 text-muted-foreground">
                {row.scheduledStartAt && row.scheduledEndAt ? (
                  <><LocalTime value={row.scheduledStartAt} />–<LocalTime value={row.scheduledEndAt} /></>
                ) : '—'}
              </td>
              <td className="py-2 pr-3">
                <LocalTime value={row.startedAt} />–{row.endedAt ? <LocalTime value={row.endedAt} /> : <span className="text-success">now</span>}
                {row.corrected ? <span className="ml-1 text-xs text-muted-foreground">(corrected)</span> : null}
              </td>
              <td className="py-2 pr-3 tabular-nums">{Math.floor(row.minutes / 60)}h {row.minutes % 60}m</td>
              <td className="py-2">
                {row.onShift ? (
                  <Badge variant="success" size="sm">On shift</Badge>
                ) : (
                  <span className="text-muted-foreground">{CLOSED_BY[row.closedBy ?? ''] ?? '—'}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CLOSED_BY: Record<string, string> = {
  SIGN_OUT: 'Signed out',
  AUTO_IDLE: 'Idle',
  AUTO_CAP: 'Ran too long',
  BRANCH_CHANGE: 'Moved site',
  MANUAL: 'Manager',
  HANDOVER: 'Handed over',
}
