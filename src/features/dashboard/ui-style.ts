/**
 * Which interface style this browser shows the dashboard in.
 *
 * Two skins over one set of screens: the classic look, and the modern one —
 * dark rail, blue accent, flat white cards. A skin and not a second UI: the
 * pages, their layout and their behaviour are identical, and only the theme
 * tokens change. That is what makes it safe to offer on every tab at once.
 *
 * A cookie for the same reason the sidebar's collapsed state is one: the
 * layout reads it while rendering, so the first frame is already in the
 * chosen style. Per browser, not per account — it is how this screen looks
 * to the person at it, like light and dark.
 */
export const UI_STYLE_COOKIE = 'ros_ui'

export type UiStyle = 'classic' | 'modern'

export const UI_STYLES: Array<{ value: UiStyle; label: string; description: string }> = [
  { value: 'classic', label: 'Classic', description: 'The current look: light rail, warm accent, frosted cards.' },
  { value: 'modern', label: 'Modern', description: 'Dark navy rail, blue accent, flat white cards.' },
]

/** A year. It is a preference, not a session. */
const MAX_AGE = 60 * 60 * 24 * 365

export function parseUiStyle(value: string | undefined | null): UiStyle {
  return value === 'modern' ? 'modern' : 'classic'
}

/** Client-side write. The server only ever reads this cookie. */
export function writeUiStyleCookie(style: UiStyle) {
  if (typeof document === 'undefined') return
  document.cookie = `${UI_STYLE_COOKIE}=${style}; path=/; max-age=${MAX_AGE}; samesite=lax`
}

/** Client-side read, for a control that shows the current choice. */
export function readUiStyleCookie(): UiStyle {
  if (typeof document === 'undefined') return 'classic'
  const match = document.cookie.match(new RegExp(`(?:^|; )${UI_STYLE_COOKIE}=([^;]*)`))
  return parseUiStyle(match?.[1])
}
