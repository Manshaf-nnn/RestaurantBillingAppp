'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRightLeft, ChefHat, LayoutDashboard, LogOut, MapPin, RefreshCw, Volume2, VolumeX, Wifi, WifiOff,
  UserRoundPlus,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/primitives'
import { StaffAlerts } from '@/components/staff-alerts'
import { ThemeToggle } from '@/components/theme-toggle'
import { logout } from '@/features/auth/actions'
import { useSocket } from '@/hooks/use-socket'
import { isRealtimeEnabled } from '@/lib/realtime/client'
import { initials } from '@/lib/utils'

/**
 * Full-bleed chrome for the always-on operational screens (kitchen, waiter,
 * cashier). Deliberately minimal: these run on wall-mounted tablets where every
 * pixel of vertical space is ticket space.
 */
export function OpsShell({
  title,
  subtitle,
  branch,
  branchIds = null,
  canAnswerCalls = false,
  user,
  soundEnabled,
  onToggleSound,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  /**
   * Which location this screen is for (correctionA.md §6).
   *
   * These screens had no branch anywhere on them, which is the worst place for
   * that gap to be: a kitchen rail and a till are physical screens in physical
   * rooms, they are *always* scoped to exactly one location — `StationBranchPicker`
   * makes people choose before the screen will load — and the consequence of
   * being wrong is food cooked in the wrong building or cash counted against
   * the wrong drawer. The dashboard at least carries the branch switcher.
   */
  branch?: string | null
  /**
   * The locations this viewer may see, so the global listener can ignore
   * another site's events. `null` means every location.
   */
  branchIds?: string[] | null
  /** Whether this person may answer a table's call from the popup. */
  canAnswerCalls?: boolean
  user: { name: string; role: string }
  soundEnabled?: boolean
  onToggleSound?: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const { connected } = useSocket()
  const realtimeOff = !isRealtimeEnabled()
  // Starts null on purpose. Seeding this with `new Date()` meant the server
  // rendered one second and the browser hydrated with another, so every ops
  // screen threw a hydration mismatch on load and React re-rendered the whole
  // header to recover. The clock is client-only information; it appears on the
  // first tick after mount instead.
  const [clock, setClock] = React.useState<Date | null>(null)

  React.useEffect(() => {
    setClock(new Date())
    const timer = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex min-h-dvh flex-col">
      {/*
        One listener for every operational screen (pro.A.md §17). A waiter call
        used to raise a popup only on /waiter; now the cashier at the till and
        the kitchen rail hear it too, wherever they are standing.
      */}
      <StaffAlerts branchIds={branchIds} branchName={branch} canAnswerCalls={canAnswerCalls} />
      <header className="glass-chrome sticky top-0 z-40 border-b">
        <div className="flex h-14 items-center gap-3 px-4">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ChefHat className="size-4" />
          </span>

          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold leading-tight">{title}</h1>
            {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>

          {/*
            Its own badge rather than more text in the subtitle: on a
            wall-mounted screen read from across a kitchen, the location is the
            one thing somebody checks at a glance, and a second grey line does
            not survive that distance.
          */}
          {branch ? (
            <Badge variant="secondary" className="shrink-0 gap-1">
              <MapPin />
              <span className="max-w-[9rem] truncate">{branch}</span>
            </Badge>
          ) : null}

          {realtimeOff ? (
            <Badge variant="secondary" className="ml-2 shrink-0">
              <RefreshCw />
              <span className="hidden sm:inline">Auto-refresh</span>
            </Badge>
          ) : (
            <Badge variant={connected ? 'success' : 'destructive'} className="ml-2 shrink-0">
              {connected ? <Wifi /> : <WifiOff />}
              <span className="hidden sm:inline">{connected ? 'Live' : 'Reconnecting'}</span>
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {actions}

            <span
              suppressHydrationWarning
              className="hidden font-mono text-sm tabular-nums text-muted-foreground md:inline"
            >
              {clock
                ? clock.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })
                : null}
            </span>

            {onToggleSound ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleSound}
                aria-label={soundEnabled ? 'Mute alerts' : 'Unmute alerts'}
                title={soundEnabled ? 'Mute alerts' : 'Unmute alerts'}
              >
                {soundEnabled ? <Volume2 /> : <VolumeX className="text-muted-foreground" />}
              </Button>
            ) : null}

            <ThemeToggle />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Account">
                  <Avatar className="size-7">
                    <AvatarFallback>{initials(user.name)}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>
                  <p className="text-sm font-semibold text-foreground">{user.name}</p>
                  <p className="text-xs font-normal">{user.role}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/dashboard">
                    <LayoutDashboard /> Dashboard
                  </Link>
                </DropdownMenuItem>
                {/*
                  Where somebody going home looks (recorrection.md §2). A
                  waiter or a cook has no drawer console and no dashboard
                  sidebar to find the handover from; the account menu, next
                  to Sign out, is the one place every floor role opens at the
                  end of a shift.
                */}
                <DropdownMenuItem asChild>
                  <Link href="/dashboard/handover">
                    <ArrowRightLeft /> Shift handover
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
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  )
}

/** Compact metric strip shown above the operational boards. */
export function OpsStats({
  items,
}: {
  items: Array<{ label: string; value: string | number; tone?: 'default' | 'warning' | 'success' | 'primary' }>
}) {
  return (
    <div className="grid grid-cols-2 gap-2 border-b bg-background px-4 py-3 sm:grid-cols-4 lg:gap-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border bg-card px-3 py-2">
          <p className="text-xs text-muted-foreground">{item.label}</p>
          <p
            className={
              item.tone === 'warning'
                ? 'text-2xl font-bold tabular-nums text-warning'
                : item.tone === 'success'
                  ? 'text-2xl font-bold tabular-nums text-success'
                  : item.tone === 'primary'
                    ? 'text-2xl font-bold tabular-nums text-primary'
                    : 'text-2xl font-bold tabular-nums'
            }
          >
            {item.value}
          </p>
        </div>
      ))}
    </div>
  )
}
