import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChefHat, LogOut } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { logout } from '@/features/auth/actions'
import { getCurrentUser } from '@/server/auth/session'

export const metadata = { title: 'Set up your restaurant' }

/**
 * Shown to an authenticated user who is not attached to a restaurant — a rare
 * edge case (e.g. a staff record whose restaurant was removed). It gives them a
 * clear exit rather than a permission wall.
 */
export default async function OnboardingPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.restaurantId) redirect('/dashboard')

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <ChefHat className="size-8" />
        </span>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Your account isn’t linked to a restaurant</h1>
          <p className="text-balance text-sm text-muted-foreground">
            This can happen if your restaurant was removed. Create a new restaurant, or sign in with a
            different account.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button asChild>
            <Link href="/register">Create a new restaurant</Link>
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
