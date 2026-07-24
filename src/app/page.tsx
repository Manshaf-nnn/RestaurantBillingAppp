import Link from 'next/link'
import {
  ArrowRight,
  BarChart3,
  Check,
  ChefHat,
  CreditCard,
  Package,
  QrCode,
  Radio,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
} from 'lucide-react'

import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { getAdminUser, getCurrentUser } from '@/server/auth/session'
import { ROLE_HOME } from '@/lib/rbac'

const FEATURES = [
  {
    icon: QrCode,
    title: 'One QR for the whole floor',
    body: 'Guests scan a single code, type their table number, and they are in the menu. No reprinting codes when you move tables.',
  },
  {
    icon: ChefHat,
    title: 'Kitchen display that keeps up',
    body: 'Tickets land instantly with a chime and a flashing card. Accept, cook, mark ready — the guest sees every step live.',
  },
  {
    icon: Radio,
    title: 'Realtime across every screen',
    body: 'Websockets tie together guests, kitchen, waiters and the till. Nothing is ever stale, nothing needs refreshing.',
  },
  {
    icon: CreditCard,
    title: 'Billing and payments built in',
    body: 'Itemised bills, tax and service charge, dynamic payment QR, cash reconciliation and printable thermal receipts.',
  },
  {
    icon: Package,
    title: 'Inventory that updates itself',
    body: 'Link recipes to ingredients and stock drops as orders cook. Low-stock and expiry alerts before you run out.',
  },
  {
    icon: BarChart3,
    title: 'Numbers you can act on',
    body: 'Revenue, peak hours, best sellers, staff performance and profit — exportable to Excel or CSV in a click.',
  },
]

const SURFACES = [
  { href: '/order', label: 'Guest ordering', icon: Smartphone, hint: 'Scan → table → menu' },
  { href: '/kitchen', label: 'Kitchen display', icon: ChefHat, hint: 'Live ticket rail' },
  { href: '/waiter', label: 'Waiter station', icon: Users, hint: 'Serve & requests' },
  { href: '/cashier', label: 'Cashier', icon: CreditCard, hint: 'Bills & payments' },
]

export default async function LandingPage() {
  const [user, admin] = await Promise.all([getCurrentUser(), getAdminUser()])
  const dashboardHref = user ? ROLE_HOME[user.role] : '/login'

  return (
    <div className="relative min-h-dvh overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] grid-fade opacity-60" />
      <div className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-primary/10 blur-[120px]" />

      <header className="relative z-10 border-b bg-background/70 backdrop-blur-xl">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-glow">
              <ChefHat className="size-5" />
            </span>
            <span className="text-[15px] font-bold tracking-tight">RestaurantOS</span>
          </Link>

          <nav className="flex items-center gap-1.5">
            <ThemeToggle />
            {admin ? (
              <Button size="sm" asChild>
                <Link href="/admin">
                  Admin console <ArrowRight />
                </Link>
              </Button>
            ) : user ? (
              <Button size="sm" asChild>
                <Link href={dashboardHref}>
                  Open dashboard <ArrowRight />
                </Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/login">Sign in</Link>
                </Button>
                <Button size="sm" asChild>
                  <Link href="/register?mode=trial">Start free trial</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main id="main" className="relative z-10">
        <section className="container pb-16 pt-20 text-center sm:pt-28">
          <Badge variant="outline" className="mx-auto mb-6 bg-background/80 py-1 backdrop-blur">
            <ShieldCheck className="text-success" />
            Multi-restaurant SaaS · isolated tenant data
          </Badge>

          <h1 className="mx-auto max-w-4xl text-balance text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl">
            The operating system for your{' '}
            <span className="bg-gradient-to-r from-primary to-chart-5 bg-clip-text text-transparent">
              restaurant floor
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-muted-foreground">
            QR ordering, kitchen display, waiter station, billing, payments, inventory and
            analytics — one platform, realtime end to end, ready for a hundred locations.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="xl" asChild>
              <Link href={user ? dashboardHref : '/register?mode=trial'}>
                {user ? 'Go to dashboard' : 'Start 30-day free trial'} <ArrowRight />
              </Link>
            </Button>
            <Button size="xl" variant="outline" asChild>
              <Link href="/order">
                <QrCode /> Try guest ordering
              </Link>
            </Button>
          </div>
          {!user && !admin ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No card required · or{' '}
              <Link href="/register?mode=request" className="font-medium text-primary hover:underline">
                buy a plan (admin approves)
              </Link>
            </p>
          ) : null}

          <div className="mx-auto mt-14 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
            {SURFACES.map((surface) => (
              <Link key={surface.href} href={surface.href} className="group">
                <Card interactive className="h-full">
                  <CardContent className="flex flex-col items-center gap-2 p-5 text-center">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-110">
                      <surface.icon className="size-5" />
                    </span>
                    <span className="text-sm font-semibold">{surface.label}</span>
                    <span className="text-xs text-muted-foreground">{surface.hint}</span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>

        <section className="container py-16">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <Card key={feature.title} interactive className="animate-fade-up">
                <CardContent className="p-6">
                  <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <feature.icon className="size-5" />
                  </span>
                  <h3 className="text-base font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section id="get-started" className="container pb-24">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <h2 className="text-balance text-3xl font-bold tracking-tight">Get started your way</h2>
            <p className="mt-2 text-balance text-muted-foreground">
              Jump straight in with a free trial, or request approval and we’ll set you up.
            </p>
          </div>

          <div className="mx-auto grid max-w-3xl gap-4 sm:grid-cols-2">
            {/* Free trial — instant access */}
            <Card interactive className="relative overflow-hidden border-primary/30">
              <span className="absolute right-4 top-4">
                <Badge variant="solid">Most popular</Badge>
              </span>
              <CardContent className="flex h-full flex-col gap-4 p-7">
                <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Sparkles className="size-5" />
                </span>
                <div>
                  <h3 className="text-lg font-bold">Free trial</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Full access for 30 days, live immediately. No card, no waiting.
                  </p>
                </div>
                <ul className="space-y-2 text-sm">
                  {['Every feature unlocked', 'Your own QR ordering link', 'Set up in minutes'].map(
                    (line) => (
                      <li key={line} className="flex items-center gap-2">
                        <Check className="size-4 shrink-0 text-success" /> {line}
                      </li>
                    ),
                  )}
                </ul>
                <Button size="lg" className="mt-auto w-full" asChild>
                  <Link href={user ? dashboardHref : '/register?mode=trial'}>
                    {user ? 'Open dashboard' : 'Start free trial'} <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* Request approval — reviewed by platform admin */}
            <Card interactive className="h-full">
              <CardContent className="flex h-full flex-col gap-4 p-7">
                <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-foreground">
                  <ShieldCheck className="size-5" />
                </span>
                <div>
                  <h3 className="text-lg font-bold">Buy a plan</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Ready to commit? Send a request — an admin reviews it and activates your account.
                  </p>
                </div>
                <ul className="space-y-2 text-sm">
                  {['Reviewed & approved by us', 'Go live once approved', 'Same full platform'].map((line) => (
                    <li key={line} className="flex items-center gap-2">
                      <Check className="size-4 shrink-0 text-success" /> {line}
                    </li>
                  ))}
                </ul>
                <Button size="lg" variant="outline" className="mt-auto w-full" asChild>
                  <Link href={user ? dashboardHref : '/register?mode=request'}>
                    Buy now <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t py-8">
        <div className="container flex flex-col items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} RestaurantOS</p>
          <div className="flex items-center gap-5">
            <Link href="/api/docs" className="transition-colors hover:text-foreground">
              API docs
            </Link>
            <Link href="/order" className="transition-colors hover:text-foreground">
              Guest menu
            </Link>
            <Link href="/login" className="transition-colors hover:text-foreground">
              Staff sign in
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
