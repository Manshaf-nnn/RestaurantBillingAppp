import { Suspense } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { Skeleton } from '@/components/ui/feedback'
import { LoginForm } from '@/features/auth/components/login-form'
import { getCurrentUser } from '@/server/auth/session'

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your TableFlow dashboard.',
}

/*
 * Read per request: this page has to know whether somebody is already signed
 * in, and a cached answer would name the wrong person — which is the whole bug
 * this screen now exists to solve.
 */
export const dynamic = 'force-dynamic'

/**
 * Signing in, including signing in as somebody else.
 *
 * The middleware sends a signed-in visitor to the dashboard, which is right for
 * a bookmark and wrong for a shared till: the person taking over the counter
 * was bounced into the app as whoever worked the last shift. `?switch=1` asks
 * for the form anyway, and this banner says plainly who is currently signed in
 * so nobody signs a handover they did not mean to.
 *
 * Nothing is cleared on arrival. A sign-in overwrites the session cookies, so
 * the handover happens only if it succeeds — a mistyped password leaves the
 * current person exactly where they were, which is what you want when the
 * queue is out of the door.
 */
export default async function LoginPage() {
  const current = await getCurrentUser().catch(() => null)

  return (
    <>
      {current ? (
        <div className="mb-5 rounded-xl border border-border bg-muted/40 p-3 text-sm">
          <p>
            <strong>{current.name}</strong> is signed in on this device.
          </p>
          <p className="mt-1 text-muted-foreground">
            Sign in below to take over, or{' '}
            <Link href="/dashboard" className="font-medium text-primary underline-offset-2 hover:underline">
              continue as {current.name}
            </Link>
            .
          </p>
        </div>
      ) : null}

      <Suspense
        fallback={
          <div className="space-y-5">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </>
  )
}
