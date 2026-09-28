import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { NewPasswordForm } from '@/features/auth/components/password-forms'
import { grantIsLive, openFlow } from '@/features/auth/password-reset'

export const metadata: Metadata = { title: 'Create a new password' }
export const dynamic = 'force-dynamic'

/**
 * Step 3 of 3: the password. Reachable only while the grant a correct code
 * earned is still live; otherwise back to the start.
 */
export default async function NewPasswordPage() {
  const store = await cookies()
  const flow = openFlow(store.get('ros_pr_flow')?.value)
  if (!(await grantIsLive(store.get('ros_pr_grant')?.value))) {
    redirect(flow?.from === 'admin' ? '/forgot-password?from=admin' : '/forgot-password')
  }
  return <NewPasswordForm from={flow?.from ?? 'staff'} />
}
