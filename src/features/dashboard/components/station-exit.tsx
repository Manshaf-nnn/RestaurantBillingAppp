import 'server-only'

import Link from 'next/link'
import { LayoutDashboard } from 'lucide-react'

import { firstReachablePath, reachableNavItems } from '../nav'
import type { PermissionSubject } from '@/lib/rbac'

/**
 * The way out of a station screen.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `/kitchen`, `/waiter` and `/cashier` are full-screen surfaces with no
 * layout — deliberately, because a kitchen display is furniture and chrome on
 * it is noise. The consequence nobody intended is that they contained **no link
 * anywhere back to the dashboard**. A cashier whose owner had switched on Stock
 * counts for them could not reach it; a kitchen lead granted Wastage had to be
 * told to type a URL.
 *
 * ── Why it is conditional ───────────────────────────────────────────────────
 *
 * It renders only when there is genuinely something behind it. A kitchen tablet
 * whose account holds nothing but `kitchen.view` gets no button, because a
 * button leading to an empty menu is worse than no button — it is a promise the
 * next screen breaks. `reachableNavItems` answers that question with the same
 * function the sidebar and the page guards use, so the three cannot disagree.
 *
 * The threshold is *more than the station itself*: a waiter whose only reachable
 * item is Waiter station is already looking at it.
 */
export function StationExit({
  user,
  /** The station this is rendered on, so it does not offer to go where you are. */
  current,
  className,
}: {
  user: PermissionSubject
  current: string
  className?: string
}) {
  const elsewhere = reachableNavItems(user).filter((item) => item.href !== current)
  if (elsewhere.length === 0) return null

  const target = firstReachablePath(user)
  const href = target && target !== current ? target : elsewhere[0].href

  return (
    <Link
      href={href}
      className={
        className ??
        'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground'
      }
    >
      <LayoutDashboard className="size-4" />
      Dashboard
    </Link>
  )
}
