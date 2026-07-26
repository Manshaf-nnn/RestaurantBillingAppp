import { Suspense } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'

import { ThemeToggle } from '@/components/theme-toggle'
import { Skeleton } from '@/components/ui/feedback'
import { LoginForm } from '@/features/auth/components/login-form'
import { getAdminUser } from '@/server/auth/session'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Platform admin sign in',
  robots: { index: false, follow: false },
}

/**
 * Dedicated platform-admin entrance. It uses a SEPARATE session cookie from the
 * restaurant staff login, so you can be signed in as admin here and as a
 * restaurant in another tab at the same time.
 */
export default async function AdminLoginPage() {
  // Already signed in as admin? Go straight to the console.
  if (await getAdminUser()) redirect('/admin')

  return (
    <div className="relative flex min-h-dvh flex-col bg-muted/30">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-5 py-16">
        <div className="w-full max-w-[420px] animate-fade-up">
          <div className="mb-6 flex flex-col items-center gap-3">
            <Link
              href="/"
              className="inline-block rounded-2xl bg-white px-7 py-5 shadow-elevated ring-1 ring-black/5"
            >
              <Image
                src="/logo-full.png"
                alt="TableFlow"
                width={1143}
                height={380}
                priority
                className="h-10 w-auto"
              />
            </Link>
            <span className="rounded-full bg-foreground px-3 py-0.5 text-xs font-semibold text-background">
              Platform Admin
            </span>
          </div>

          <div className="rounded-3xl border bg-card/80 p-6 shadow-elevated backdrop-blur sm:p-8">
            <Suspense fallback={<Skeleton className="h-72 w-full" />}>
              <LoginForm variant="admin" />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
