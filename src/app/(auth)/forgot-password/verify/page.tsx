import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { VerifyResetCodeForm } from '@/features/auth/components/password-forms'
import { describeFlow, openFlow } from '@/features/auth/password-reset'

export const metadata: Metadata = { title: 'Enter reset code' }
export const dynamic = 'force-dynamic'

/**
 * Step 2 of 3: the code. Reachable only with the flow cookie step 1 set;
 * anyone arriving without one is sent back to ask for a code.
 */
export default async function VerifyResetCodePage() {
  const store = await cookies()
  const flow = openFlow(store.get('ros_pr_flow')?.value)
  if (!flow) redirect('/forgot-password')

  const { maskedEmail, cooldownSeconds } = await describeFlow(flow)
  return <VerifyResetCodeForm maskedEmail={maskedEmail} cooldownSeconds={cooldownSeconds} from={flow.from} />
}
