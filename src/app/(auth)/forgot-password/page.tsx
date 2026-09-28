import type { Metadata } from 'next'

import { ForgotPasswordForm } from '@/features/auth/components/password-forms'

export const metadata: Metadata = { title: 'Forgot password' }

/** Step 1 of 3: the address. `?from=admin` only changes where "Back to sign in" goes. */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  return <ForgotPasswordForm from={params.from === 'admin' ? 'admin' : 'staff'} />
}
