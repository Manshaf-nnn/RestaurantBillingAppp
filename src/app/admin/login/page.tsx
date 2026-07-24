import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { ShieldCheck } from 'lucide-react'

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
        <div className="w-full max-w-[400px] animate-fade-up">
          <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-foreground text-background">
              <ShieldCheck className="size-5" />
            </span>
            <span className="text-[15px] font-bold tracking-tight">RestaurantOS · Admin</span>
          </Link>

          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <LoginForm variant="admin" />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
