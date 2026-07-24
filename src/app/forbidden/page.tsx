import Link from 'next/link'
import { ArrowLeft, ShieldX } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ROLE_HOME } from '@/lib/rbac'
import { getCurrentUser } from '@/server/auth/session'

export const metadata = { title: 'Access denied' }

export default async function ForbiddenPage() {
  const user = await getCurrentUser()
  const home = user ? ROLE_HOME[user.role] : '/login'

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <ShieldX className="size-8" />
        </span>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">You do not have access here</h1>
          <p className="text-balance text-sm text-muted-foreground">
            {user
              ? `Your role does not include this area. Ask an owner or manager if you need it.`
              : 'Sign in with an account that has permission for this area.'}
          </p>
        </div>
        <Button asChild>
          <Link href={home}>
            <ArrowLeft /> Back to your workspace
          </Link>
        </Button>
      </div>
    </main>
  )
}
