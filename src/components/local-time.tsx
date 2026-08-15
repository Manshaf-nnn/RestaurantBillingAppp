'use client'

import * as React from 'react'

/**
 * Renders a timestamp in the viewer's own timezone, without breaking hydration.
 *
 * `toLocaleTimeString` inside a client component is evaluated twice: once on the
 * server, in the server's timezone and locale, and again in the browser, in the
 * guest's. Those disagree for most of the world, so React finds different text
 * than the HTML it was given and throws away the tree to re-render it. The
 * symptom is a hydration error on any screen showing a clock time.
 *
 * The server pass renders a stable placeholder instead, and the real local time
 * appears on mount. A timestamp is viewer-local information; there is no correct
 * value to render before we know whose screen it is.
 */
export function LocalTime({
  value,
  options = { hour: '2-digit', minute: '2-digit' },
  locale,
  className,
}: {
  value: string | Date
  options?: Intl.DateTimeFormatOptions
  locale?: string
  className?: string
}) {
  const [text, setText] = React.useState<string | null>(null)

  React.useEffect(() => {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
      setText('—')
      return
    }
    setText(date.toLocaleTimeString(locale ?? [], options))
    // `options` is an inline object at most call sites; stringify so a new
    // identity each render does not restart the effect forever.
  }, [value, locale, JSON.stringify(options)])

  return (
    <span suppressHydrationWarning className={className}>
      {text ?? '·'}
    </span>
  )
}

/** Same guarantee, for a full date + time. */
export function LocalDateTime({
  value,
  options,
  locale,
  className,
}: {
  value: string | Date
  options?: Intl.DateTimeFormatOptions
  locale?: string
  className?: string
}) {
  const [text, setText] = React.useState<string | null>(null)

  React.useEffect(() => {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
      setText('—')
      return
    }
    setText(
      options ? date.toLocaleString(locale ?? [], options) : date.toLocaleString(locale ?? []),
    )
  }, [value, locale, JSON.stringify(options)])

  return (
    <span suppressHydrationWarning className={className}>
      {text ?? '·'}
    </span>
  )
}
