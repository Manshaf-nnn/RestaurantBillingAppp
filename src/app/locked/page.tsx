import type { Metadata } from 'next'
import Link from 'next/link'
import { Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { FEATURES } from '@/features/access/features'
import { firstReachablePath } from '@/features/dashboard/nav'
import { getCurrentUser } from '@/server/auth/session'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Not in your plan' }

/**
 * A feature this restaurant has not bought.
 *
 * ── Why this is not `/forbidden` ────────────────────────────────────────────
 *
 * `/forbidden` means "your role does not reach this", and the fix is to ask
 * whoever manages roles. This is a different dead end: no role edit will ever
 * open it, because the restaurant does not have the feature at all. Sending
 * somebody to their manager for something their manager cannot grant wastes
 * both their time.
 *
 * ── Why it says the data is safe ────────────────────────────────────────────
 *
 * Because that is the first thing anybody wonders, and because it is true.
 * Switching a feature off is a read-side gate; every row stays exactly where it
 * was and reappears the moment it is switched back on.
 */
export default async function LockedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = await searchParams
  const permission = typeof query.feature === 'string' ? query.feature : ''

  // Name the feature rather than the permission. "inventory.view" means nothing
  // to a restaurant owner; "Inventory" does.
  const feature = FEATURES.find((entry) =>
    entry.actions.some((action) => action.permission === permission),
  )

  const user = await getCurrentUser()
  const home = user ? firstReachablePath(user) : null

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted">
          <Lock className="size-6 text-muted-foreground" />
        </div>

        <h1 className="mt-5 text-xl font-bold tracking-tight">
          {feature ? `${feature.label} isn’t part of your plan` : 'That isn’t part of your plan'}
        </h1>

        <p className="mt-2 text-sm text-muted-foreground">
          {feature ? `${feature.description} ` : ''}
          Your plan doesn’t include it at the moment.
        </p>

        <p className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Nothing has been deleted. Any {feature ? feature.label.toLowerCase() : ''} data you have
          entered is still there, exactly as you left it, and comes straight back if this is
          switched on.
        </p>

        <p className="mt-4 text-sm text-muted-foreground">
          Contact TableFlow to add it to your plan.
        </p>

        <div className="mt-6">
          <Button asChild variant="outline">
            <Link href={home ?? '/dashboard'}>Back to where you were</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
