import { Suspense } from 'react'
import type { Metadata } from 'next'

import { Skeleton } from '@/components/ui/feedback'
import { LoginForm } from '@/features/auth/components/login-form'

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your RestaurantOS dashboard.',
}

export default function LoginPage() {
  return (
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
  )
}
