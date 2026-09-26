'use client'

import type { UserRole } from '@prisma/client'
import { BranchSwitcher, type SwitchableLocation } from './branch-switcher'
import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Bell,
  Building2,
  ShieldCheck,
  ExternalLink,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings,
  Sparkles,
  User,
  Wifi,
  WifiOff,
  X,
  UserRoundPlus,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, SheetContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Avatar,
  AvatarFallback,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/primitives'
import { ThemeToggle } from '@/components/theme-toggle'
import { EVENTS, type NotificationPayload } from '@/lib/realtime/events'
import { cn, initials } from '@/lib/utils'
import { permissionsFor, ROLE_LABELS } from '@/lib/rbac'
import { StaffAlerts } from '@/components/staff-alerts'
import { useSocket, useSocketEvent } from '@/hooks/use-socket'
import { isRealtimeEnabled } from '@/lib/realtime/client'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { logout } from '@/features/auth/actions'
import { LocalTime } from '@/components/local-time'
import { markAllRead, markRead, setNavFavorites } from '../actions'
import { GlobalSearch } from '@/features/search/components/global-search'
import {
  favoriteItems,
  navItemForPath,
  recentItems,
  sanitiseFavorites,
  visibleSections,
  type NavItem,
} from '../nav'
import { SidebarNav } from './sidebar-nav'
import { writeSidebarCookie } from '../sidebar-preference'
import { useRecentPages } from '../use-recent-pages'
import { callAction } from '@/lib/use-action'

export interface ShellUser {
  id: string
  name: string
  email: string
  // Derived from the enum rather than spelled out, so a new role cannot
  // compile here while being invisible to the shell.
  role: UserRole
  permissions: string[]
  /**
   * The saved role's complete list, when this person holds one.
   *
   * The sidebar has to be handed the same three inputs `permissionsFor` reads
   * on the server, or it filters against the preset defaults and shows items
   * the pages then refuse — a menu that lies, which is the failure the whole
   * feature-toggle system exists to avoid.
   */
  rolePermissions: string[] | null
  avatarUrl: string | null
  /**
   * Sidebar shortcuts, in this person's own order (sidebar.md §1).
   *
   * Hrefs, not items — an icon is a React component and does not survive the
   * trip from the server. They are resolved against `visibleSections` here, so
   * a shortcut to a page this person may no longer open simply stops appearing.
   */
  navFavorites: string[]
}

export interface ShellNotification {
  id: string
  title: string
  body: string | null
  createdAt: string
  readAt: string | null
  /** Where it points, when the producer said. Null renders a plain entry. */
  href: string | null
}

export function DashboardShell({
  user,
  locations,
  branchIds = null,
  seesEverything = false,
  restaurantName,
  orderUrl,
  trialDaysLeft,
  unassignedToLocation,
  initialNotifications,
  openTasks = 0,
  initialCollapsed = false,
  uiStyle = 'classic',
  children,
}: {
  user: ShellUser
  /** Locations this user may see; the switcher hides itself with nothing to pick. */
  locations?: SwitchableLocation[]
  /**
   * The same reach as ids, for filtering live events. `null` means every
   * location — the value `visibleBranchIds` already returns.
   */
  branchIds?: string[] | null
  /**
   * Whether this person's reach is unrestricted. Drives the "Main admin" row —
   * see `BranchSwitcher`.
   */
  seesEverything?: boolean
  restaurantName: string
  orderUrl: string
  trialDaysLeft?: number | null
  /**
   * True when this account is tied to one location and has not been given one.
   *
   * `visibleBranchIds` fails closed for that case — it returns an empty list,
   * and `scopeToOne` turns it into a sentinel that matches nothing — which is
   * the right security answer and a terrible explanation. Every screen went
   * blank: no orders, no stock, no drawer history, no error. This says why.
   */
  unassignedToLocation?: boolean
  initialNotifications: ShellNotification[]
  /**
   * Outstanding instructions for this person. Shown as a count beside "Things
   * to do", and only when there are any — a permanent grey zero is furniture,
   * and people stop seeing furniture.
   */
  openTasks?: number
  /**
   * Whether this browser last left the sidebar collapsed, read from a cookie on
   * the server so the rail is the right width in the first painted frame rather
   * than snapping after hydration. See `sidebar-preference.ts`.
   */
  initialCollapsed?: boolean
  /**
   * Which skin to draw the shell in. Read from a cookie by the layout, so the
   * first frame is already right — see `ui-style.ts`. A class on the root,
   * and the stylesheet does the rest; nothing below reads it.
   */
  uiStyle?: 'classic' | 'modern'
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { connected } = useSocket()
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [notifications, setNotifications] = React.useState(initialNotifications)
  const [collapsed, setCollapsed] = React.useState(initialCollapsed)
  const { play } = useNotificationSound()

  // `visibleSections` in nav.ts, not a second copy of the same filter — the
  // station screens and /forbidden ask the same question and have to get the
  // same answer.
  const sections = React.useMemo(() => visibleSections(user), [user])

  /*
   * ── Favorites ─────────────────────────────────────────────────────────────
   *
   * Held as hrefs and resolved on render, so `favoriteItems` — which filters
   * through the same permission list as the sidebar — is the only thing that
   * decides what appears. sidebar.md §7: take a permission away and the
   * shortcut goes with it, with nothing extra to remember.
   */
  const [favoriteHrefs, setFavoriteHrefs] = React.useState(user.navFavorites)

  // The server is authoritative. A reload after a failed save, or a permission
  // change made by somebody else, arrives as a new prop and must win over
  // whatever this tab optimistically believes.
  React.useEffect(() => setFavoriteHrefs(user.navFavorites), [user.navFavorites])

  const favorites = React.useMemo(
    () => favoriteItems(user, favoriteHrefs),
    [user, favoriteHrefs],
  )

  /** Optimistic, then saved; on failure the previous list comes straight back. */
  const saveFavorites = React.useCallback(
    async (next: string[]) => {
      const previous = favoriteHrefs
      setFavoriteHrefs(next)
      const result = await callAction(() => setNavFavorites({ hrefs: next }))
      if (!result.ok) {
        setFavoriteHrefs(previous)
        toast.error(result.error)
        return
      }
      // What the server kept, which may be shorter than what was sent if a
      // permission changed between the click and the write.
      setFavoriteHrefs(result.data.hrefs)
    },
    [favoriteHrefs],
  )

  const toggleFavorite = React.useCallback(
    (href: string) => {
      const current = sanitiseFavorites(user, favoriteHrefs)
      if (current.includes(href)) {
        void saveFavorites(current.filter((entry) => entry !== href))
        return
      }
      // Appended, not prepended: a new pin should not push the shortcut
      // somebody reaches for every morning out from under their cursor.
      void saveFavorites([...current, href])
    },
    [user, favoriteHrefs, saveFavorites],
  )

  const moveFavorite = React.useCallback(
    (from: number, to: number) => {
      const current = favorites.map((item) => item.href)
      if (from === to || to < 0 || to >= current.length) return
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      void saveFavorites(next)
    },
    [favorites, saveFavorites],
  )

  /*
   * ── Recent ────────────────────────────────────────────────────────────────
   *
   * Recorded in two places, and both are needed. The effect below catches deep
   * links, the back button and anything opened from inside a page. The sidebar's
   * own click handler catches POS, the kitchen display and the waiter station —
   * those leave this layout entirely for `OpsShell`, which has no sidebar, so a
   * pathname effect here would never see the most-used screen in the product.
   * The list dedupes, so the overlap costs nothing.
   */
  const { recent: recentHrefs, record } = useRecentPages(user.id)

  React.useEffect(() => {
    const item = navItemForPath(user, pathname)
    if (item) record(item.href)
  }, [pathname, user, record])

  const recent = React.useMemo(() => {
    const starred = new Set(favorites.map((item) => item.href))
    const here = navItemForPath(user, pathname)?.href
    /*
     * Two things are left out, both for §6's "keep the sidebar clean".
     *
     * Favorites, because they already own the rows above and listing POS twice
     * in six inches helps nobody.
     *
     * And the page being looked at right now, because a shortcut to where you
     * already are is not a shortcut — and it is also the one row the full menu
     * below is highlighting, so leaving it in draws the same name in the same
     * colour twice and makes the sidebar look like it has lost its place.
     */
    return recentItems(
      user,
      recentHrefs.filter((href) => !starred.has(href) && href !== here),
    )
  }, [user, recentHrefs, favorites, pathname])

  const isActive = React.useCallback(
    (item: NavItem) =>
      item.exact
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`),
    [pathname],
  )

  const searchablePages = React.useMemo(
    () =>
      sections.flatMap((section) =>
        section.items.map((item) => ({
          href: item.href,
          label: item.label,
          section: section.title,
        })),
      ),
    [sections],
  )

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((current) => {
      const next = !current
      writeSidebarCookie(next)
      return next
    })
  }, [])

  useSocketEvent(EVENTS.NOTIFICATION, (payload: NotificationPayload) => {
    /*
     * Only what belongs here (pro.A.md §15).
     *
     * Role rooms carry no branch segment, so a MANAGEMENT push reaches every
     * site at once — and the bell list this prepends to IS branch-filtered on
     * the server. Without this check a Kandy manager saw a Colombo toast and a
     * bell row that vanished on the next render. `null` is a genuine
     * business-wide notice and belongs to everybody.
     */
    if (branchIds !== null && payload.branchId && !branchIds.includes(payload.branchId)) return
    setNotifications((current) => [
      // A socket payload carries no destination; the next full load fills it.
      { id: payload.id, title: payload.title, body: payload.body, createdAt: payload.createdAt, readAt: null, href: null },
      ...current.slice(0, 29),
    ])
    play('alert')
    // A table calling raises the shared popup below; a toast as well would be
    // the same news twice.
    if (payload.type !== 'SERVICE_REQUEST') {
      toast(payload.title, { description: payload.body ?? undefined })
    }
  })

  React.useEffect(() => setMobileOpen(false), [pathname])

  const unread = notifications.filter((notification) => !notification.readAt).length

  /*
   * Sidebar links carry the chosen location forward.
   *
   * The hrefs in `nav.ts` are plain strings, so clicking any of them dropped
   * `?branch=`. The page then fell back to the cookie and stayed scoped to the
   * branch, while the switcher — which reads the URL — snapped back to "All
   * locations". Label and figures disagreed after every single navigation, and
   * the figures were the ones telling the truth.
   */
  const branchParam = searchParams.get('branch')
  const withBranch = React.useCallback(
    (href: string) => {
      if (!branchParam) return href
      /*
       * `?` or `&`, depending on what is already there. Two nav entries carry a
       * query string of their own — `/cashier/pos?type=TAKEAWAY` and its
       * DELIVERY twin — and blind concatenation produced
       * `…?type=TAKEAWAY?branch=…`, a URL where the second parameter is
       * unreadable. Harmless today because the till does not read the branch,
       * and a trap the moment it does.
       */
      const separator = href.includes('?') ? '&' : '?'
      return `${href}${separator}branch=${encodeURIComponent(branchParam)}`
    },
    [branchParam],
  )

  /*
   * One component, two surfaces — the desktop rail and the mobile sheet render
   * the same `SidebarNav` with different props, as they shared one JSX fragment
   * before it grew Favorites, Recent and search. The sheet is never collapsed:
   * a phone has no room to spare, and an icon rail inside a bottom sheet is a
   * menu with the words taken out for no gain.
   */
  const nav = (options: { collapsed: boolean }) => (
    <SidebarNav
      user={user}
      sections={sections}
      favorites={favorites}
      recent={recent}
      collapsed={options.collapsed}
      openTasks={openTasks}
      isActive={isActive}
      withBranch={withBranch}
      onToggleFavorite={toggleFavorite}
      onMoveFavorite={moveFavorite}
      onVisit={record}
      onExpand={() => {
        setCollapsed(false)
        writeSidebarCookie(false)
      }}
    />
  )

  return (
    <div className={cn('flex min-h-dvh', uiStyle === 'modern' && 'ui-modern')}>
      {/*
        The same table-calling popup the till and the kitchen get
        (pro.A.md §17). A manager reading the dashboard is often the person who
        answers, and until now only /waiter ever showed it.
      */}
      <StaffAlerts branchIds={branchIds} canAnswerCalls />
      {/* ── desktop sidebar ─────────────────────────────────────── */}
      <aside
        className={cn(
          'glass-chrome sticky top-0 hidden h-dvh shrink-0 flex-col border-r transition-[width] duration-200 lg:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        {/*
          Carries the branch like every other link. Clicking the logo used to
          drop it, landing on a bare /dashboard where the cookie decided — so
          the switcher read "All locations" while the figures were still one
          branch's, or the other way about.
        */}
        <Link
          href={withBranch('/dashboard')}
          className={cn(
            'flex h-16 items-center gap-2.5 border-b',
            collapsed ? 'justify-center px-2' : 'px-5',
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white shadow-soft">
            <Image src="/logo-mark.png" alt="" width={512} height={512} className="size-full object-contain p-0.5" />
          </span>
          {collapsed ? null : (
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold leading-tight">{restaurantName}</span>
              <span className="block text-[11px] text-muted-foreground">TableFlow</span>
            </span>
          )}
        </Link>

        {nav({ collapsed })}

        <div className={cn('flex items-center gap-2 border-t p-3', collapsed && 'flex-col')}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand' : 'Collapse'}
            className="shrink-0"
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>

          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" asChild>
                  <a href={orderUrl} target="_blank" rel="noreferrer" aria-label="Guest menu">
                    <ExternalLink />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Guest menu</TooltipContent>
            </Tooltip>
          ) : (
            <Button variant="outline" size="sm" className="flex-1" asChild>
              <a href={orderUrl} target="_blank" rel="noreferrer">
                <ExternalLink /> Guest menu
              </a>
            </Button>
          )}
        </div>
      </aside>

      {/* ── mobile drawer ───────────────────────────────────────── */}
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent className="max-h-[85dvh] lg:hidden">
          <div className="flex items-center justify-between px-4 pb-2">
            <span className="text-sm font-bold">{restaurantName}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(false)} aria-label="Close">
              <X />
            </Button>
          </div>
          {nav({ collapsed: false })}
        </SheetContent>
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass-chrome sticky top-0 z-30 flex h-16 items-center gap-2 border-b px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>

          <Link href={withBranch('/dashboard')} className="flex items-center gap-2 lg:hidden">
            <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white shadow-soft">
              <Image src="/logo-mark.png" alt="TableFlow" width={512} height={512} className="size-full object-contain p-0.5" />
            </span>
          </Link>

          {/*
            Shown on a phone as well. A branch manager standing in their own store
            is the most likely person to need the switcher, and they are the least
            likely to be at a desk.
          */}
          {/*
            The "is there a choice to make" test now lives inside the switcher,
            because it depends on whether the all-sites row is offered as well
            as on how many locations there are.
          */}
          {locations && locations.length > 0 ? (
            <BranchSwitcher locations={locations} seesEverything={seesEverything} />
          ) : null}

          {/*
            The pages this person may open, handed to the ⌘K box so it can
            answer "where is wastage" as well as "where is that invoice".
            Computed here because `sections` is already on this side of the
            wire and already permission-filtered — so the Pages group needs no
            request of its own and cannot offer a screen the sidebar would not.
          */}
          <GlobalSearch pages={searchablePages} />

          {isRealtimeEnabled() ? (
            <Badge variant={connected ? 'success' : 'destructive'} className="hidden sm:inline-flex">
              {connected ? <Wifi /> : <WifiOff />}
              {connected ? 'Live' : 'Offline'}
            </Badge>
          ) : (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              <RefreshCw /> Auto-refresh
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-1">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
                  <Bell />
                  {unread > 0 ? (
                    <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground">
                      {unread > 9 ? '9+' : unread}
                    </span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[calc(100vw-1.5rem)] max-w-80 p-0">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <p className="text-sm font-semibold">Notifications</p>
                  {unread > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await callAction(() => markAllRead())
                        setNotifications((current) =>
                          current.map((entry) => ({ ...entry, readAt: new Date().toISOString() })),
                        )
                      }}
                    >
                      Mark all read
                    </Button>
                  ) : null}
                </div>

                <ScrollArea className="max-h-80">
                  {notifications.length === 0 ? (
                    <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                      You are all caught up.
                    </p>
                  ) : (
                    <ul className="divide-y">
                      {notifications.map((notification) => {
                        const body = (
                          <>
                            <p className="text-sm font-medium">{notification.title}</p>
                            {notification.body ? (
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {notification.body}
                              </p>
                            ) : null}
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              <LocalTime value={notification.createdAt} />
                            </p>
                          </>
                        )
                        return (
                          <li
                            key={notification.id}
                            className={cn(!notification.readAt && 'bg-primary/5')}
                          >
                            {/*
                              Tapping an entry goes where it points AND marks it
                              read — acting on a notification IS reading it, and
                              per-item read is what lets "mark all" stop wiping
                              the ones nobody has dealt with yet.
                            */}
                            {notification.href ? (
                              <Link
                                href={notification.href}
                                className="block px-4 py-3 hover:bg-muted/60"
                                onClick={() => {
                                  setNotifications((current) =>
                                    current.map((entry) =>
                                      entry.id === notification.id
                                        ? { ...entry, readAt: entry.readAt ?? new Date().toISOString() }
                                        : entry,
                                    ),
                                  )
                                  void callAction(() => markRead(notification.id))
                                }}
                              >
                                {body}
                              </Link>
                            ) : (
                              <button
                                type="button"
                                className="block w-full px-4 py-3 text-left"
                                onClick={() => {
                                  setNotifications((current) =>
                                    current.map((entry) =>
                                      entry.id === notification.id
                                        ? { ...entry, readAt: entry.readAt ?? new Date().toISOString() }
                                        : entry,
                                    ),
                                  )
                                  void callAction(() => markRead(notification.id))
                                }}
                              >
                                {body}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </ScrollArea>
              </PopoverContent>
            </Popover>

            <ThemeToggle />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2">
                  <Avatar className="size-7">
                    <AvatarFallback>{initials(user.name)}</AvatarFallback>
                  </Avatar>
                  <span className="hidden text-sm font-medium sm:inline">{user.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-sm font-semibold text-foreground">{user.name}</p>
                  <p className="truncate text-xs font-normal">{user.email}</p>
                  <Badge variant="secondary" size="sm" className="mt-1.5">
                    {ROLE_LABELS[user.role]}
                  </Badge>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/dashboard/settings/profile">
                    <User /> My profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/dashboard/settings">
                    <Settings /> Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/*
                  Handing the counter over (sidebar.md — role links).
                  The middleware sends a signed-in person away from the login
                  page, so without this the next cashier had no way to reach
                  the form and was silently dropped into the app as whoever
                  worked the last shift. `?switch=1` asks for the form anyway.
                */}
                <DropdownMenuItem asChild>
                  <Link href="/login?switch=1">
                    <UserRoundPlus /> Sign in as someone else
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem destructive onClick={() => void logout()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {unassignedToLocation ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-warning/10 px-4 py-2 text-sm text-warning lg:px-6">
            <Building2 className="size-4 shrink-0" />
            <span className="font-medium">Your account is not assigned to a location.</span>
            <span className="text-muted-foreground">
              That is why these screens are empty — ask the owner to set your location on the Staff
              screen.
            </span>
          </div>
        ) : null}

        {/*
          An empty sidebar looks like a broken page, and it is usually a role
          somebody built and never ticked anything on. Saying so turns a
          mystery into a sentence the person can repeat to their manager.
        */}
        {sections.length === 0 ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-warning/10 px-4 py-2 text-sm text-warning lg:px-6">
            <ShieldCheck className="size-4 shrink-0" />
            <span className="font-medium">No features are switched on for your role yet.</span>
            <span className="text-muted-foreground">
              That is why the menu is empty — ask the owner to enable what you need under Roles
              &amp; access.
            </span>
          </div>
        ) : null}

        {typeof trialDaysLeft === 'number' ? (
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-sm lg:px-6',
              trialDaysLeft <= 5
                ? 'bg-warning/10 text-warning'
                : 'bg-primary/10 text-primary',
            )}
          >
            <Sparkles className="size-4" />
            <span className="font-medium">
              {trialDaysLeft === 0
                ? 'Your free trial ends today.'
                : `${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left in your free trial.`}
            </span>
            <span className="text-muted-foreground">Enjoy full access — no card needed.</span>
          </div>
        ) : null}

        <main id="main" className="flex-1 p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
