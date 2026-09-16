import { Badge } from '@/components/ui/badge'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatDateTime } from '@/lib/datetime'
import type { ServiceRequestHistoryRow } from '../service-requests'

/**
 * Every waiter call in the period (abc.md §7): who called, who went, who
 * closed it, and how long each step took. A server component — nothing
 * here needs a click — so the rows arrive rendered.
 */
const LABEL: Record<string, string> = {
  CALL_WAITER: 'Waiter called',
  WATER: 'Water',
  PLATES: 'Extra plates',
  BILL: 'Bill requested',
  HELP: 'Needs help',
  CLEAN_TABLE: 'Clean table',
}

const STATUS: Record<string, { label: string; variant: 'warning' | 'info' | 'success' }> = {
  OPEN: { label: 'Waiting', variant: 'warning' },
  ACKNOWLEDGED: { label: 'On the way', variant: 'info' },
  RESOLVED: { label: 'Done', variant: 'success' },
}

function minutesBetween(from: Date, to: Date | null): string {
  if (!to) return '—'
  const mins = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000))
  return mins === 0 ? '<1 min' : `${mins} min`
}

export function WaiterCallsHistory({
  rows,
  timeZone,
  locale,
  showBranch,
  branchNames,
}: {
  rows: ServiceRequestHistoryRow[]
  timeZone: string
  locale: string
  /** Only worth a column when the list spans more than one location. */
  showBranch: boolean
  branchNames: Record<string, string>
}) {
  const open = rows.filter((row) => row.status !== 'RESOLVED').length
  return (
    <SectionCard
      id="waiter-calls"
      title="Waiter calls"
      description={
        rows.length === 0
          ? 'No table called in this period.'
          : `${rows.length} call${rows.length === 1 ? '' : 's'} in the period above${open ? ` · ${open} still open` : ''}.`
      }
    >
      {rows.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">When</th>
                {showBranch ? <th className="py-1.5 pr-3 font-medium">Location</th> : null}
                <th className="py-1.5 pr-3 font-medium">Table</th>
                <th className="py-1.5 pr-3 font-medium">Need</th>
                <th className="py-1.5 pr-3 font-medium">Called by</th>
                <th className="py-1.5 pr-3 font-medium">Answered</th>
                <th className="py-1.5 pr-3 font-medium">Done</th>
                <th className="py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-1.5 pr-3 tabular-nums">{formatDateTime(row.createdAt, { timeZone, locale })}</td>
                  {showBranch ? (
                    <td className="py-1.5 pr-3">{row.branchId ? branchNames[row.branchId] ?? '—' : '—'}</td>
                  ) : null}
                  <td className="py-1.5 pr-3 font-semibold">T{row.tableNumber}</td>
                  <td className="py-1.5 pr-3">
                    {LABEL[row.type] ?? row.type}
                    {row.note ? <span className="text-muted-foreground"> · {row.note}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3">{row.requestedByName ?? `Table ${row.tableNumber}`}</td>
                  <td className="py-1.5 pr-3">
                    {row.acknowledgedByName ?? '—'}
                    <span className="text-muted-foreground"> · {minutesBetween(row.createdAt, row.acknowledgedAt)}</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {row.handledByName ?? '—'}
                    <span className="text-muted-foreground"> · {minutesBetween(row.createdAt, row.resolvedAt)}</span>
                  </td>
                  <td className="py-1.5">
                    <Badge variant={STATUS[row.status]?.variant ?? 'secondary'} size="sm">
                      {STATUS[row.status]?.label ?? row.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}
