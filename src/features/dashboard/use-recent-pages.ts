'use client'

import * as React from 'react'

import { MAX_RECENT } from './nav'

/**
 * The pages this person opened last (sidebar.md §3).
 *
 * ── Why the browser and not the database ────────────────────────────────────
 *
 * §9 says not to make a database request every time the sidebar renders, and a
 * server-side Recent is worse than that: it is a database *write* on every
 * navigation, on a list nobody would miss if a device lost it. Favorites are
 * deliberate and belong to the person, so they live on the user row; Recent is
 * a trail, and a trail belongs to the machine that made it. A till that three
 * people share should not advertise where the last one went.
 *
 * ── Why it starts empty ─────────────────────────────────────────────────────
 *
 * Reading `localStorage` during render is a hydration mismatch: the server has
 * no storage, so it renders nothing, and the browser renders five rows. React
 * then throws away the tree and re-renders it. `ops-shell.tsx` carries the scar
 * from doing exactly this with a clock. So the list starts empty, is read once
 * after mount, and appears a frame later — which is invisible below the fold of
 * a sidebar and costs nothing.
 *
 * Every access is wrapped: a private window, blocked site data, or a browser
 * with storage disabled all THROW on `localStorage`, and a sidebar that fails to
 * draw because it could not remember where somebody has been is a bad trade.
 */
const key = (userId: string) => `ros:nav-recent:${userId}`

function read(userId: string): string[] {
  try {
    const raw = window.localStorage.getItem(key(userId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Trusting the shape here would put anything a browser extension wrote into
    // a `<Link href>`. Strings only, capped, and every one of them is still
    // matched against the nav registry before it is rendered.
    return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

function write(userId: string, hrefs: string[]) {
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(hrefs))
  } catch {
    // Storage full, or disabled. The list in memory is still correct for this
    // session, which is all Recent ever promised.
  }
}

export function useRecentPages(userId: string): {
  recent: string[]
  record: (href: string) => void
} {
  const [recent, setRecent] = React.useState<string[]>([])

  // Once, after mount, and again if the signed-in person changes — two members
  // of staff sharing a tablet must not inherit each other's history.
  React.useEffect(() => setRecent(read(userId)), [userId])

  const record = React.useCallback(
    (href: string) => {
      setRecent((current) => {
        // Already at the front: nothing moved, so do not write and do not hand
        // back a new array, which would re-render the sidebar on every click of
        // the page you are already on.
        if (current[0] === href) return current

        const next = [href, ...current.filter((entry) => entry !== href)].slice(0, MAX_RECENT)
        write(userId, next)
        return next
      })
    },
    [userId],
  )

  return { recent, record }
}
