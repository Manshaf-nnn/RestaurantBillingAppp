import Link from 'next/link'
import type { Metadata } from 'next'
import { CheckCircle2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { verifyEmail } from '@/features/auth/actions'

export const metadata: Metadata = { title: 'Confirm email' }

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  const result = token ? await verifyEmail(token) : null
  const verified = result?.ok === true

  return (
    <div className="space-y-6 text-center">
      <span
        className={`mx-auto flex size-14 items-center justify-center rounded-2xl ${
          verified ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
        }`}
      >
        {verified ? <CheckCircle2 className="size-7" /> : <XCircle className="size-7" />}
      </span>

      <div className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">
          {verified ? 'Email confirmed' : 'We could not confirm that link'}
        </h1>
        <p className="text-balance text-sm text-muted-foreground">
          {verified
            ? 'Your email address is verified. You have full access to your dashboard.'
            : (result && !result.ok ? result.error : 'This confirmation link is missing or invalid.') +
              ' You can request a new link from your account settings.'}
        </p>
      </div>

      <Button className="w-full" asChild>
        <Link href={verified ? '/dashboard' : '/login'}>
          {verified ? 'Go to dashboard' : 'Back to sign in'}
        </Link>
      </Button>
    </div>
  )
}
