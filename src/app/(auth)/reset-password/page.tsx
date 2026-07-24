import { Suspense } from 'react'
import type { Metadata } from 'next'

import { Skeleton } from '@/components/ui/feedback'
import { ResetPasswordForm } from '@/features/auth/components/password-forms'

export const metadata: Metadata = { title: 'Reset password' }

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ResetPasswordForm />
    </Suspense>
  )
}
