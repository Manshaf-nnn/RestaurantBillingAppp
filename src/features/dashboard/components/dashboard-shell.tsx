'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Bell,
  ChefHat,
  ExternalLink,
  LogOut,
  Menu,
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
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { logout } from '@/features/auth/actions'
import { markAllRead } from '../actions'
import { NAV_SECTIONS } from '../nav'

export interface ShellUser {
  id: string
  name: string
  email: string
  role: 'SUPER_ADMIN' | 'OWNER' | 'MANAGER' | 'KITCHEN' | 'CASHIER' | 'WAITER'
  permissions: string[]
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
  restaurantName,
  orderUrl,
  trialDaysLeft,
  initialNotifications,
  children,
}: {
  user: ShellUser
  restaurantName: string
  orderUrl: string
  trialDaysLeft?: number | null
  initialNotifications: ShellNotification[]
  children: React.ReactNode
}) {
  const pathname = usePathname()
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
                    href={item.href}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
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
    <div className="flex min-h-dvh bg-muted/30">
      {/* ── desktop sidebar ─────────────────────────────────────── */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-background lg:flex">
        <Link href="/dashboard" className="flex h-16 items-center gap-2.5 border-b px-5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ChefHat className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold leading-tight">{restaurantName}</span>
            <span className="block text-[11px] text-muted-foreground">RestaurantOS</span>
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
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur-xl">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>

          <Link href="/dashboard" className="flex items-center gap-2 lg:hidden">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ChefHat className="size-3.5" />
            </span>
          </Link>

          <Badge variant={connected ? 'success' : 'destructive'} className="hidden sm:inline-flex">
            {connected ? <Wifi /> : <WifiOff />}
            {connected ? 'Live' : 'Offline'}
          </Badge>

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
              <PopoverContent align="end" className="w-80 p-0">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <p className="text-sm font-semibold">Notifications</p>
                  {unread > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await markAllRead()
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
                            {new Date(notification.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
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
