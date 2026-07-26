import { Suspense } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'

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
    <div className="theme-light relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#f5f6fa] px-4 py-10 text-foreground">
      <div className="pointer-events-none absolute -left-40 -top-24 size-[520px] rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-40 size-[520px] rounded-full bg-chart-5/10 blur-3xl" />

      <div className="relative z-10 w-full max-w-[440px] animate-fade-up">
        <div className="rounded-[28px] border border-black/[0.06] bg-white p-8 shadow-elevated sm:p-10">
          <div className="mb-8 flex flex-col items-center gap-3">
            <Link href="/">
              <Image
                src="/logo-full.png"
                alt="TableFlow"
                width={1143}
                height={380}
                priority
                className="h-11 w-auto"
              />
            </Link>
            <span className="rounded-full bg-foreground px-3 py-0.5 text-xs font-semibold text-background">
              Platform Admin
            </span>
          </div>

          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <LoginForm variant="admin" />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} TableFlow · Smart Dining, Simplified
        </p>
      </div>
    </div>
  )
}
