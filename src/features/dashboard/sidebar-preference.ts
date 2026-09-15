/**
 * Whether this browser keeps the sidebar collapsed (sidebar.md §5).
 *
 * ── Why a cookie, and why a readable one ────────────────────────────────────
 *
 * `localStorage` cannot be read while the server renders, so the first frame of
 * every single page load would be a 256px sidebar snapping to 64px once React
 * mounted — on every navigation, for the whole life of the preference. Reading a
 * cookie in the dashboard layout, which is already dynamic because it reads the
 * session, gets the width right in the HTML itself. No flash and no hydration
 * mismatch.
 *
 * Not `httpOnly`, unlike `ros_branch` beside it. That one decides which
 * restaurant's money you are looking at and is re-checked server-side on every
 * read; this one decides how wide a `<aside>` is. Making it httpOnly would buy
 * nothing and cost a server round trip per click on a control people toggle
 * absent-mindedly.
 */
export const SIDEBAR_COOKIE = 'ros_sidebar'

export type SidebarState = 'collapsed' | 'expanded'

/** A year. It is a preference, not a session. */
const MAX_AGE = 60 * 60 * 24 * 365

/** Client-side write. The server only ever reads this cookie. */
export function writeSidebarCookie(collapsed: boolean) {
  if (typeof document === 'undefined') return
  const value: SidebarState = collapsed ? 'collapsed' : 'expanded'
  document.cookie = `${SIDEBAR_COOKIE}=${value}; path=/; max-age=${MAX_AGE}; samesite=lax`
}
