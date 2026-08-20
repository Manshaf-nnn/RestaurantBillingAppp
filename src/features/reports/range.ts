/**
 * Date ranges for reports.
 *
 * Ranges are resolved server-side from a preset name rather than trusting two
 * dates off the query string, so "this month" means the same thing on every
 * screen and a malformed range cannot ask the database for ten years of rows.
 *
 * Boundaries are local-midnight to local-midnight in the restaurant's own day,
 * not UTC. A restaurant closing at 1am wants that hour on the previous day's
 * takings, and a report that silently splits a service across two days is worse
 * than no report.
 */

export type RangePreset =
  | 'TODAY'
  | 'YESTERDAY'
  | 'THIS_WEEK'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'LAST_7'
  | 'LAST_30'
  | 'CUSTOM'

export interface DateRange {
  from: Date
  to: Date
  preset: RangePreset
  label: string
}

export const RANGE_LABELS: Record<RangePreset, string> = {
  TODAY: 'Today',
  YESTERDAY: 'Yesterday',
  THIS_WEEK: 'This week',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  LAST_7: 'Last 7 days',
  LAST_30: 'Last 30 days',
  CUSTOM: 'Custom range',
}

const MAX_DAYS = 400

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

export function resolveRange(params: {
  preset?: string | null
  from?: string | null
  to?: string | null
  now?: Date
}): DateRange {
  const now = params.now ?? new Date()
  const preset = (params.preset ?? 'TODAY') as RangePreset

  if (preset === 'CUSTOM' && params.from && params.to) {
    const from = new Date(params.from)
    const to = new Date(params.to)
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to) {
      // Cap the span rather than reject it: an owner dragging a date picker
      // past a year wants a report, not an error.
      const capped = new Date(Math.min(to.getTime(), from.getTime() + MAX_DAYS * 86_400_000))
      return { from: startOfDay(from), to: endOfDay(capped), preset, label: RANGE_LABELS.CUSTOM }
    }
  }

  switch (preset) {
    case 'YESTERDAY': {
      const d = new Date(now.getTime() - 86_400_000)
      return { from: startOfDay(d), to: endOfDay(d), preset, label: RANGE_LABELS.YESTERDAY }
    }
    case 'THIS_WEEK': {
      // Weeks start Monday — the convention in Sri Lanka and most of the world.
      const day = (now.getDay() + 6) % 7
      const monday = new Date(now.getTime() - day * 86_400_000)
      return { from: startOfDay(monday), to: endOfDay(now), preset, label: RANGE_LABELS.THIS_WEEK }
    }
    case 'THIS_MONTH':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1),
        to: endOfDay(now),
        preset,
        label: RANGE_LABELS.THIS_MONTH,
      }
    case 'LAST_MONTH': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: first, to: endOfDay(last), preset, label: RANGE_LABELS.LAST_MONTH }
    }
    case 'LAST_7':
      return {
        from: startOfDay(new Date(now.getTime() - 6 * 86_400_000)),
        to: endOfDay(now),
        preset,
        label: RANGE_LABELS.LAST_7,
      }
    case 'LAST_30':
      return {
        from: startOfDay(new Date(now.getTime() - 29 * 86_400_000)),
        to: endOfDay(now),
        preset,
        label: RANGE_LABELS.LAST_30,
      }
    default:
      return { from: startOfDay(now), to: endOfDay(now), preset: 'TODAY', label: RANGE_LABELS.TODAY }
  }
}
