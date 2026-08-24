/**
 * Date ranges for reports and for the dashboard.
 *
 * Ranges are resolved server-side from a preset name rather than trusting two
 * dates off the query string, so "this month" means the same thing on every
 * screen and a malformed range cannot ask the database for ten years of rows.
 *
 * ── Boundaries are the restaurant's own midnight ─────────────────────────────
 *
 * This file's header used to promise exactly that and the code did not deliver
 * it: `new Date(y, m, d)` is midnight in the SERVER's timezone, which on a
 * cloud host is UTC. For a restaurant in `Asia/Kolkata` that put the start of
 * "today" five and a half hours late, so every order between local midnight and
 * 05:30 was counted on the previous day — quietly, and on every screen that
 * asked for a range.
 *
 * It matters more now than it did: a period selector shows the seam. A day
 * view with the wrong boundary is visibly missing its first hours.
 *
 * The conversion goes through `Intl.DateTimeFormat`, which is the only
 * timezone-correct date derivation already in this codebase — see
 * `orders/service.ts` for order numbering and `orders/pricing.ts` for happy
 * hours. This is the third, and it is deliberately the same technique.
 *
 * ── One vocabulary ──────────────────────────────────────────────────────────
 *
 * There is a second `resolveRange` in `features/analytics/queries.ts` speaking
 * lowercase presets (`today|week|month|quarter|year|custom`). It still serves
 * `/dashboard/reports` and the export route and works; this one is canonical
 * for anything new. Do not add a third.
 */

export type RangePreset =
  | 'TODAY'
  | 'YESTERDAY'
  | 'THIS_WEEK'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'LAST_7'
  | 'LAST_30'
  | 'LAST_90'
  | 'THIS_YEAR'
  | 'CUSTOM'

/**
 * How the range should be bucketed for a chart.
 *
 * A day wants 24 bars, a month wants ~30, a year wants 12. Derived from the
 * span rather than chosen separately, so the two can never disagree.
 */
export type Granularity = 'hour' | 'day' | 'month'

export interface DateRange {
  from: Date
  to: Date
  preset: RangePreset
  label: string
  /** The restaurant's timezone the boundaries were computed in. */
  timeZone: string
  granularity: Granularity
}

export const RANGE_LABELS: Record<RangePreset, string> = {
  TODAY: 'Today',
  YESTERDAY: 'Yesterday',
  THIS_WEEK: 'This week',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  LAST_7: 'Last 7 days',
  LAST_30: 'Last 30 days',
  LAST_90: 'Last 90 days',
  THIS_YEAR: 'This year',
  CUSTOM: 'Custom range',
}

/** Presets the dashboard offers, in the order the owner asked for them. */
export const DASHBOARD_PRESETS: RangePreset[] = [
  'TODAY',
  'YESTERDAY',
  'THIS_WEEK',
  'THIS_MONTH',
  'LAST_30',
  'LAST_90',
  'THIS_YEAR',
]

const MAX_DAYS = 400
const DAY_MS = 86_400_000

/** What a wall clock in `timeZone` reads at this instant. */
function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some runtimes render midnight as "24" under hour12:false.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  }
}

/**
 * The zone's offset from UTC, in ms, at a given instant.
 *
 * Measured on a whole second, because `Intl` reports no milliseconds — comparing
 * a second-precision reading against an instant carrying `.999` would fold that
 * fraction into the offset and shift every boundary by up to a second. Zone
 * offsets are whole minutes, so rounding the probe costs nothing.
 */
function offsetAt(instant: Date, timeZone: string): number {
  const whole = new Date(Math.floor(instant.getTime() / 1000) * 1000)
  const p = zonedParts(whole, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole.getTime()
}

/**
 * The instant at which a wall-clock time occurs in `timeZone`.
 *
 * Applied twice on purpose. The offset has to be measured *at* the instant we
 * are looking for, and we do not know it yet — so the first pass uses the
 * offset at the naive guess and the second corrects it. That matters only on
 * the two days a year a DST zone shifts, which `Asia/Kolkata` never does, but
 * the restaurants using this are not all in one place.
 */
function fromZoned(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const once = naive - offsetAt(new Date(naive), timeZone)
  return new Date(naive - offsetAt(new Date(once), timeZone))
}

function startOfDay(d: Date, tz: string): Date {
  const p = zonedParts(d, tz)
  return fromZoned(tz, p.year, p.month, p.day)
}

function endOfDay(d: Date, tz: string): Date {
  const p = zonedParts(d, tz)
  return fromZoned(tz, p.year, p.month, p.day, 23, 59, 59, 999)
}

function startOfMonth(d: Date, tz: string): Date {
  const p = zonedParts(d, tz)
  return fromZoned(tz, p.year, p.month, 1)
}

/**
 * Bars that are worth reading.
 *
 * Two days or fewer are hours — a single day as one bar tells you nothing. Up
 * to a quarter is days. Beyond that a daily chart is a smear, so it is months.
 */
export function granularityFor(from: Date, to: Date): Granularity {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS))
  if (days <= 2) return 'hour'
  if (days <= 92) return 'day'
  return 'month'
}

export function resolveRange(params: {
  preset?: string | null
  from?: string | null
  to?: string | null
  now?: Date
  /** The restaurant's timezone. Defaults to the server's, as before. */
  timeZone?: string
}): DateRange {
  const now = params.now ?? new Date()
  const tz = params.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const preset = (params.preset ?? 'TODAY') as RangePreset

  const finish = (from: Date, to: Date, chosen: RangePreset): DateRange => ({
    from,
    to,
    preset: chosen,
    label: RANGE_LABELS[chosen],
    timeZone: tz,
    granularity: granularityFor(from, to),
  })

  if (preset === 'CUSTOM' && params.from && params.to) {
    const from = new Date(params.from)
    const to = new Date(params.to)
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to) {
      /*
       * Cap the span rather than reject it: an owner dragging a date picker
       * past a year wants a report, not an error.
       *
       * `MAX_DAYS - 1`, because both ends are inclusive — the range runs from
       * the start of the first day to the end of the last, so adding 400 whole
       * days would give 401 days of data under a constant called MAX_DAYS.
       */
      const capped = new Date(Math.min(to.getTime(), from.getTime() + (MAX_DAYS - 1) * DAY_MS))
      return finish(startOfDay(from, tz), endOfDay(capped, tz), 'CUSTOM')
    }
  }

  switch (preset) {
    case 'YESTERDAY': {
      const d = new Date(now.getTime() - DAY_MS)
      return finish(startOfDay(d, tz), endOfDay(d, tz), preset)
    }
    case 'THIS_WEEK': {
      // Weeks start Monday — the convention in Sri Lanka and most of the world.
      const p = zonedParts(now, tz)
      const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
      const back = (weekday + 6) % 7
      const monday = new Date(startOfDay(now, tz).getTime() - back * DAY_MS)
      return finish(startOfDay(monday, tz), endOfDay(now, tz), preset)
    }
    case 'THIS_MONTH':
      return finish(startOfMonth(now, tz), endOfDay(now, tz), preset)
    case 'LAST_MONTH': {
      const p = zonedParts(now, tz)
      const first = fromZoned(tz, p.year, p.month - 1 || 12, 1)
      const lastDay = new Date(startOfMonth(now, tz).getTime() - DAY_MS)
      return finish(startOfDay(first, tz), endOfDay(lastDay, tz), preset)
    }
    case 'LAST_7':
      return finish(startOfDay(new Date(now.getTime() - 6 * DAY_MS), tz), endOfDay(now, tz), preset)
    case 'LAST_30':
      return finish(startOfDay(new Date(now.getTime() - 29 * DAY_MS), tz), endOfDay(now, tz), preset)
    case 'LAST_90':
      return finish(startOfDay(new Date(now.getTime() - 89 * DAY_MS), tz), endOfDay(now, tz), preset)
    case 'THIS_YEAR': {
      const p = zonedParts(now, tz)
      return finish(fromZoned(tz, p.year, 1, 1), endOfDay(now, tz), preset)
    }
    default:
      return finish(startOfDay(now, tz), endOfDay(now, tz), 'TODAY')
  }
}

/**
 * The window of equal length immediately before this one.
 *
 * What "up 12%" is measured against. The dashboard used to compare today with
 * yesterday and nothing else; with a period selector the only comparison that
 * means anything is a month against the month before it, a year against the
 * year before.
 */
export function previousRange(range: DateRange): { from: Date; to: Date } {
  const span = range.to.getTime() - range.from.getTime()
  return {
    from: new Date(range.from.getTime() - span - 1),
    to: new Date(range.from.getTime() - 1),
  }
}

/**
 * A complete range from two instants you already hold.
 *
 * For callers that have real Dates rather than query-string text — tests, and
 * report code that computed its own window. Exists so nobody hand-writes the
 * object literal: `granularity` and `timeZone` are derived here, and four
 * scattered literals would drift the moment a fifth field is added.
 */
export function customRange(from: Date, to: Date, timeZone?: string): DateRange {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return {
    from,
    to,
    preset: 'CUSTOM',
    label: RANGE_LABELS.CUSTOM,
    timeZone: tz,
    granularity: granularityFor(from, to),
  }
}

/**
 * The range as dates a person reads, e.g. "1 – 24 Aug 2026".
 *
 * For the places that must say what a figure actually covers rather than name
 * the button that was pressed. "This month" is fine on the control; a card
 * headed "Revenue" beside a comparison to "the previous month" needs to be
 * specific, and a CUSTOM range has no name at all.
 *
 * Formatted in the restaurant's timezone, since that is what the boundaries
 * were computed in — printing them in the server's would undo the whole point.
 */
export function describeRange(range: DateRange, locale = 'en-GB'): string {
  const day: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    timeZone: range.timeZone,
  }
  const withYear: Intl.DateTimeFormatOptions = { ...day, year: 'numeric' }

  const sameDay =
    new Intl.DateTimeFormat('en-CA', { timeZone: range.timeZone }).format(range.from) ===
    new Intl.DateTimeFormat('en-CA', { timeZone: range.timeZone }).format(range.to)

  if (sameDay) return new Intl.DateTimeFormat(locale, withYear).format(range.from)

  return `${new Intl.DateTimeFormat(locale, day).format(range.from)} – ${new Intl.DateTimeFormat(
    locale,
    withYear,
  ).format(range.to)}`
}

/**
 * How to describe what a delta is measured against, in words.
 *
 * The dashboard used to say "vs yesterday" under every figure because
 * yesterday was the only comparison it made. With a selectable period the
 * comparison moves with it, and a stale caption on a correct number is how a
 * reader ends up trusting the wrong thing.
 */
export function comparisonLabel(range: DateRange): string {
  switch (range.preset) {
    case 'TODAY':
      return 'vs yesterday'
    case 'YESTERDAY':
      return 'vs the day before'
    case 'THIS_WEEK':
      return 'vs the week before'
    case 'THIS_MONTH':
    case 'LAST_MONTH':
      return 'vs the month before'
    case 'THIS_YEAR':
      return 'vs the year before'
    default:
      return 'vs the previous period'
  }
}
