export interface DayHours {
  open: string // "09:00"
  close: string // "23:00"
  closed?: boolean
}

export type OpeningHours = Partial<Record<DayKey, DayHours>>

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type DayKey = (typeof DAY_KEYS)[number]

export const DAY_LABELS: Record<DayKey, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
}

export const DEFAULT_HOURS: OpeningHours = {
  mon: { open: '11:00', close: '23:00' },
  tue: { open: '11:00', close: '23:00' },
  wed: { open: '11:00', close: '23:00' },
  thu: { open: '11:00', close: '23:00' },
  fri: { open: '11:00', close: '23:30' },
  sat: { open: '10:00', close: '23:30' },
  sun: { open: '10:00', close: '22:30' },
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours || 0) * 60 + (minutes || 0)
}

function nowInZone(timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)

  return { day: day < 0 ? 0 : day, minutes: hour * 60 + minute }
}

export function parseOpeningHours(value: unknown): OpeningHours {
  if (!value || typeof value !== 'object') return DEFAULT_HOURS
  const record = value as Record<string, unknown>
  const result: OpeningHours = {}
  for (const key of DAY_KEYS) {
    const entry = record[key]
    if (entry && typeof entry === 'object') {
      const day = entry as DayHours
      if (typeof day.open === 'string' && typeof day.close === 'string') {
        result[key] = { open: day.open, close: day.close, closed: Boolean(day.closed) }
      }
    }
  }
  return Object.keys(result).length ? result : DEFAULT_HOURS
}

/** Is the restaurant serving right now? Handles windows that cross midnight. */
export function isOpenNow(hours: OpeningHours, timeZone = 'Asia/Kolkata'): boolean {
  const { day, minutes } = nowInZone(timeZone)
  const today = hours[DAY_KEYS[day]]
  if (today && !today.closed) {
    const open = toMinutes(today.open)
    const close = toMinutes(today.close)
    if (open <= close ? minutes >= open && minutes < close : minutes >= open) return true
  }

  // A window opened yesterday may still be running (e.g. 22:00 → 02:00).
  const yesterday = hours[DAY_KEYS[(day + 6) % 7]]
  if (yesterday && !yesterday.closed) {
    const open = toMinutes(yesterday.open)
    const close = toMinutes(yesterday.close)
    if (open > close && minutes < close) return true
  }

  return false
}

export function todayLabel(hours: OpeningHours, timeZone = 'Asia/Kolkata'): string | null {
  const { day } = nowInZone(timeZone)
  const today = hours[DAY_KEYS[day]]
  if (!today || today.closed) return 'Closed today'
  return `${today.open} – ${today.close}`
}
