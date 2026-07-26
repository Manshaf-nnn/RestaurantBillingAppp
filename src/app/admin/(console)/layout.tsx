import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { ThemeToggle } from '@/components/theme-toggle'
import { AdminAccountMenu } from '@/features/platform/components/admin-account-menu'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageSuperAdmin('/admin')

  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-xl">
        <div className="container flex h-16 items-center gap-3">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
              <ShieldCheck className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold leading-tight">TableFlow</span>
              <span className="block text-[11px] text-muted-foreground">Platform admin</span>
            </span>
          </Link>

          <Badge variant="secondary" className="ml-1">
            Super Admin
          </Badge>

          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <AdminAccountMenu name={user.name} email={user.email} />
          </div>
        </div>
      </header>

      <main id="main" className="container py-6">
        {children}
      </main>
    </div>
  )
}
