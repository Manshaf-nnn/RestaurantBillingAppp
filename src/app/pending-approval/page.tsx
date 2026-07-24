import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Clock, LogOut, Mail, ShieldX } from 'lucide-react'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { logout } from '@/features/auth/actions'
import { getCurrentUser } from '@/server/auth/session'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Pending approval' }

/**
 * Waiting room for an owner whose restaurant has not yet been approved (or was
 * suspended/rejected) by the platform admin.
 */
export default async function PendingApprovalPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.role === 'SUPER_ADMIN') redirect('/admin')
  if (!user.restaurantId) redirect('/onboarding')

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: user.restaurantId },
    select: { name: true, status: true, rejectionReason: true },
  })

  // Approved already? Send them straight to their dashboard.
  if (!restaurant || restaurant.status === 'ACTIVE') redirect('/dashboard')

  const rejected = restaurant.status === 'REJECTED'
  const suspended = restaurant.status === 'SUSPENDED'

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md space-y-6 text-center">
        <span
          className={`mx-auto flex size-16 items-center justify-center rounded-2xl ${
            rejected || suspended ? 'bg-destructive/10 text-destructive' : 'bg-warning/15 text-warning'
          }`}
        >
          {rejected || suspended ? <ShieldX className="size-8" /> : <Clock className="size-8" />}
        </span>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">
            {rejected
              ? 'Your registration was declined'
              : suspended
                ? 'Your restaurant is suspended'
                : 'Waiting for approval'}
          </h1>
          <p className="text-balance text-sm text-muted-foreground">
            {rejected
              ? 'A platform administrator reviewed your registration and could not approve it.'
              : suspended
                ? 'Access to your restaurant has been paused by a platform administrator.'
                : `Thanks for signing up, ${user.name.split(' ')[0]}. A platform administrator is reviewing ${restaurant.name}. You’ll get full access the moment it’s approved.`}
          </p>
        </div>

        {rejected && restaurant.rejectionReason ? (
          <Alert variant="destructive" title="Reason">
            {restaurant.rejectionReason}
          </Alert>
        ) : null}

        {!rejected && !suspended ? (
          <div className="rounded-xl border bg-card p-4 text-left text-sm shadow-soft">
            <p className="flex items-center gap-2 font-medium">
              <Mail className="size-4 text-primary" /> What happens next
            </p>
            <ul className="mt-2 space-y-1.5 text-muted-foreground">
              <li>• An admin reviews your details (usually within a day).</li>
              <li>• Once approved, this page unlocks your full dashboard.</li>
              <li>• You can sign in again any time to check your status.</li>
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button className="w-full" asChild>
            <a href="/pending-approval">Refresh status</a>
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
