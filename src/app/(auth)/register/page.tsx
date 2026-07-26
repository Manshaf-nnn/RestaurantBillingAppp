import type { Metadata } from 'next'

import { RegisterForm } from '@/features/auth/components/register-form'

export const metadata: Metadata = {
  title: 'Register your restaurant',
  description: 'Request access to TableFlow — an admin approves your account.',
}

export default function RegisterPage() {
  return <RegisterForm />
}
