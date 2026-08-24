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
  ExternalLink,
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  Sparkles,
  User,
  Wifi,
  WifiOff,
  X,
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
import { Avatar, AvatarFallback, Popover, PopoverContent, PopoverTrigger, ScrollArea } from '@/components/ui/primitives'
import { ThemeToggle } from '@/components/theme-toggle'
import { EVENTS, type NotificationPayload } from '@/lib/realtime/events'
import { cn, initials } from '@/lib/utils'
import { permissionsFor, ROLE_LABELS } from '@/lib/rbac'
import { useSocket, useSocketEvent } from '@/hooks/use-socket'
import { isRealtimeEnabled } from '@/lib/realtime/client'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { logout } from '@/features/auth/actions'
import { LocalTime } from '@/components/local-time'
import { markAllRead } from '../actions'
import { GlobalSearch } from '@/features/search/components/global-search'
import { NAV_SECTIONS } from '../nav'
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
}

export interface ShellNotification {
  id: string
  title: string
  body: string | null
  createdAt: string
  readAt: string | null
}

export function DashboardShell({
  user,
  locations,
  restaurantName,
  orderUrl,
  trialDaysLeft,
  unassignedToLocation,
  initialNotifications,
  openTasks = 0,
  children,
}: {
  user: ShellUser
  /** Locations this user may see; the switcher hides itself below two. */
  locations?: SwitchableLocation[]
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
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { connected } = useSocket()
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [notifications, setNotifications] = React.useState(initialNotifications)
  const { play } = useNotificationSound()

  const granted = React.useMemo(() => permissionsFor(user), [user])

  const sections = React.useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((item) => granted.has(item.permission)),
      })).filter((section) => section.items.length > 0),
    [granted],
  )

  useSocketEvent(EVENTS.NOTIFICATION, (payload: NotificationPayload) => {
    setNotifications((current) => [
      { id: payload.id, title: payload.title, body: payload.body, createdAt: payload.createdAt, readAt: null },
      ...current.slice(0, 29),
    ])
    play('alert')
    toast(payload.title, { description: payload.body ?? undefined })
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

  const nav = (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`)

              return (
                <li key={item.href}>
                  <Link
                    href={withBranch(item.href)}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {item.href === '/dashboard/tasks' && openTasks > 0 ? (
                      <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                        {openTasks > 9 ? '9+' : openTasks}
                      </span>
                    ) : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )

  return (
    <div className="flex min-h-dvh">
      {/* ── desktop sidebar ─────────────────────────────────────── */}
      <aside className="glass-chrome sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r lg:flex">
        {/*
          Carries the branch like every other link. Clicking the logo used to
          drop it, landing on a bare /dashboard where the cookie decided — so
          the switcher read "All locations" while the figures were still one
          branch's, or the other way about.
        */}
        <Link href={withBranch('/dashboard')} className="flex h-16 items-center gap-2.5 border-b px-5">
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white shadow-soft">
            <Image src="/logo-mark.png" alt="" width={512} height={512} className="size-full object-contain p-0.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold leading-tight">{restaurantName}</span>
            <span className="block text-[11px] text-muted-foreground">TableFlow</span>
          </span>
        </Link>

        {nav}

        <div className="border-t p-3">
          <Button variant="outline" size="sm" className="w-full" asChild>
            <a href={orderUrl} target="_blank" rel="noreferrer">
              <ExternalLink /> Guest menu
            </a>
          </Button>
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
          {nav}
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
          {locations && locations.length > 1 ? (
            <BranchSwitcher locations={locations} />
          ) : null}

          <GlobalSearch />

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
                      {notifications.map((notification) => (
                        <li
                          key={notification.id}
                          className={cn('px-4 py-3', !notification.readAt && 'bg-primary/5')}
                        >
                          <p className="text-sm font-medium">{notification.title}</p>
                          {notification.body ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">{notification.body}</p>
                          ) : null}
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            <LocalTime value={notification.createdAt} />
                          </p>
                        </li>
                      ))}
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
