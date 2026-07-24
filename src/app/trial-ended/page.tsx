import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Clock, LogOut, Mail } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { logout } from '@/features/auth/actions'
import { getCurrentUser } from '@/server/auth/session'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Trial ended' }

/** Shown when a restaurant's free trial has run out. */
export default async function TrialEndedPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.role === 'SUPER_ADMIN') redirect('/admin')
  if (!user.restaurantId) redirect('/onboarding')

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: user.restaurantId },
    select: { name: true, plan: true, trialEndsAt: true },
  })
  if (!restaurant) redirect('/onboarding')

  // Still within the trial (or upgraded)? Back to the dashboard.
  const expired =
    restaurant.plan === 'TRIAL' &&
    restaurant.trialEndsAt !== null &&
    restaurant.trialEndsAt.getTime() < Date.now()
  if (!expired) redirect('/dashboard')

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md space-y-6 text-center">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-warning/15 text-warning">
          <Clock className="size-8" />
        </span>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Your free trial has ended</h1>
          <p className="text-balance text-sm text-muted-foreground">
            Thanks for trying RestaurantOS with {restaurant.name}. Your 30-day trial is over — upgrade
            to keep your dashboard, menu and orders exactly as you left them.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-4 text-left text-sm shadow-soft">
          <p className="flex items-center gap-2 font-medium">
            <Mail className="size-4 text-primary" /> Ready to continue?
          </p>
          <p className="mt-1 text-muted-foreground">
            Get in touch to activate a paid plan. Your data is safe and waiting.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button className="w-full" asChild>
            <a href="mailto:sales@restaurantos.app?subject=Upgrade my RestaurantOS plan">
              Contact us to upgrade
            </a>
          </Button>
          <form action={logout}>
            <Button type="submit" variant="ghost" className="w-full">
              <LogOut /> Sign out
            </Button>
          </form>
        </div>
      </div>
    </main>
  )
}
