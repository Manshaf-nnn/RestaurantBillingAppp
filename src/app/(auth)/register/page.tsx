import type { Metadata } from 'next'

import { RegisterForm } from '@/features/auth/components/register-form'

export const metadata: Metadata = {
  title: 'Create your restaurant',
  description: 'Start your free RestaurantOS trial or request access.',
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>
}) {
  const { mode } = await searchParams
  return <RegisterForm mode={mode === 'request' ? 'request' : 'trial'} />
}
