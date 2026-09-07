/**
 * Dates and times, rendered in the restaurant's own timezone.
 *
 * A client component that calls `toLocaleString(locale)` on a server-rendered
 * page formats the value TWICE: once on the server, in the server's timezone
 * (UTC on Netlify), and again in the browser, in the viewer's. The two strings
 * differ, which React reports as a hydration mismatch — and neither of them is
 * the answer the reader wants. A bill rung up at 8pm in Colombo was rung up at
 * 8pm whether it is read from the next room or from London, so business time is
 * the restaurant's time.
 *
 * Pass `timeZone` and both halves agree, on the only clock that means anything
 * here. Without one this behaves exactly as before, so a caller that has no
 * tenant to hand is no worse off.
 *
 * Client-safe: pure formatting.
 */

export interface WhenOptions {
  locale?: string
  /** The restaurant's IANA zone, e.g. 'Asia/Colombo'. */
  timeZone?: string | null
  dateStyle?: 'full' | 'long' | 'medium' | 'short'
  timeStyle?: 'full' | 'long' | 'medium' | 'short'
}

function options(when: WhenOptions): Intl.DateTimeFormatOptions {
  const format: Intl.DateTimeFormatOptions = {}
  if (when.dateStyle) format.dateStyle = when.dateStyle
  if (when.timeStyle) format.timeStyle = when.timeStyle
  if (when.timeZone) format.timeZone = when.timeZone
  return format
}

/** Date and time together, e.g. "07/09/2026, 20:15". */
export function formatDateTime(value: Date | string | number, when: WhenOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return date.toLocaleString(when.locale, {
      dateStyle: when.dateStyle ?? 'short',
      timeStyle: when.timeStyle ?? 'short',
      ...(when.timeZone ? { timeZone: when.timeZone } : {}),
    })
  } catch {
    // An unknown zone must never take a page down with it.
    return date.toLocaleString(when.locale, { dateStyle: 'short', timeStyle: 'short' })
  }
}

/** The date alone. */
export function formatDate(value: Date | string | number, when: WhenOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return date.toLocaleDateString(when.locale, options({ ...when, dateStyle: when.dateStyle ?? 'medium' }))
  } catch {
    return date.toLocaleDateString(when.locale)
  }
}

/** The time alone, for a ticket or a timeline. */
export function formatTime(value: Date | string | number, when: WhenOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return date.toLocaleTimeString(when.locale, options({ ...when, timeStyle: when.timeStyle ?? 'short' }))
  } catch {
    return date.toLocaleTimeString(when.locale)
  }
}
