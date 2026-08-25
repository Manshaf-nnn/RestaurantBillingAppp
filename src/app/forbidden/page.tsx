import Link from 'next/link'
import { ArrowLeft, LogOut, ShieldX } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { firstReachablePath } from '@/features/dashboard/nav'
import { logout } from '@/features/auth/actions'
import { getCurrentUser } from '@/server/auth/session'

export const metadata = { title: 'Access denied' }

/**
 * Refused — and given somewhere real to go.
 *
 * This used to offer "Back to your workspace" pointing at `ROLE_HOME[role]`,
 * which is the page that had just refused them in the commonest case: a role
 * whose landing screen its own permissions do not cover. Press the button,
 * get refused, press it again. `firstReachablePath` asks the sidebar what this
 * person may actually open, and only falls back to the landing page when they
 * genuinely hold it.
 *
 * When there is nothing at all, it says so and offers a sign-out rather than a
 * link that will fail. Somebody stuck here is usually mid-setup — a role built
 * with no features ticked — and a dead end with no explanation is how that
 * turns into a support call.
 */
export default async function ForbiddenPage() {
  const user = await getCurrentUser()
  const home = user ? firstReachablePath(user) : '/login'

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <ShieldX className="size-8" />
        </span>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">You do not have access here</h1>
          <p className="text-balance text-sm text-muted-foreground">
            {!user
              ? 'Sign in with an account that has permission for this area.'
              : home
                ? 'Your role does not include this area. Ask an owner or manager if you need it.'
                : 'Your role does not include any area yet. Ask an owner or manager to switch some features on for you.'}
          </p>
        </div>

        {home ? (
          <Button asChild>
            <Link href={home}>
              <ArrowLeft /> Back to your workspace
            </Link>
          </Button>
        ) : (
          <form action={logout}>
            <Button type="submit" variant="outline" className="w-full">
              <LogOut /> Sign out
            </Button>
          </form>
        )}
      </div>
    </main>
  )
}
