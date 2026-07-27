'use client'

import * as React from 'react'
import Link from 'next/link'
import { ChefHat, LayoutDashboard, LogOut, RefreshCw, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react'

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
  user,
  soundEnabled,
  onToggleSound,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  user: { name: string; role: string }
  soundEnabled?: boolean
  onToggleSound?: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const { connected } = useSocket()
  const realtimeOff = !isRealtimeEnabled()
  const [clock, setClock] = React.useState(() => new Date())

  React.useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="glass-chrome sticky top-0 z-40 border-b">
        <div className="flex h-14 items-center gap-3 px-4">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ChefHat className="size-4" />
          </span>

          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold leading-tight">{title}</h1>
            {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>

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

            <span className="hidden font-mono text-sm tabular-nums text-muted-foreground md:inline">
              {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
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
                <DropdownMenuSeparator />
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
