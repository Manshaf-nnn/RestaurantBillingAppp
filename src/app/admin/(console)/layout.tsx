import Image from 'next/image'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { ThemeToggle } from '@/components/theme-toggle'
import { AdminAccountMenu } from '@/features/platform/components/admin-account-menu'
import { requirePageSuperAdmin } from '@/server/auth/guard'

/**
 * The console's sections (production.md §8).
 *
 * The order is the order an operator needs them in, not alphabetical: the
 * tenants they run, then the system they watch, then the levers they pull.
 */
const NAV = [
  {
    label: 'Tenants',
    items: [
      { href: '/admin', label: 'Restaurants' },
      { href: '/admin/branches', label: 'Branches' },
      { href: '/admin/users', label: 'Users' },
      { href: '/admin/subscriptions', label: 'Subscriptions' },
      { href: '/admin/plans', label: 'Feature plans' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/admin/overview', label: 'Overview' },
      { href: '/admin/health', label: 'System health' },
      { href: '/admin/database', label: 'Database' },
      { href: '/admin/realtime', label: 'Realtime' },
      { href: '/admin/jobs', label: 'Jobs' },
      { href: '/admin/errors', label: 'Errors' },
    ],
  },
  {
    label: 'Safety',
    items: [
      { href: '/admin/security', label: 'Security' },
      { href: '/admin/audit', label: 'Audit log' },
      { href: '/admin/backups', label: 'Backups' },
      { href: '/admin/maintenance', label: 'Maintenance' },
      { href: '/admin/media', label: 'Media' },
    ],
  },
] as const

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageSuperAdmin('/admin')

  return (
    <div className="min-h-dvh">
      <header className="glass-chrome sticky top-0 z-40 border-b">
        <div className="container flex h-16 items-center gap-3">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white shadow-soft">
              <Image src="/logo-mark.png" alt="" width={512} height={512} className="size-full object-contain p-0.5" />
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

      {/*
        * Fifteen sections, one row, no dropdowns (production.md §8: keep the UI
        * extremely simple). Grouped by what an operator is doing — running the
        * business, then watching the system, then acting on it — because the
        * order somebody scans in an incident is not alphabetical.
        */}
      <nav aria-label="Platform sections" className="border-b bg-muted/30">
        <div className="container flex flex-wrap gap-x-4 gap-y-1 py-2 text-sm">
          {NAV.map((group, index) => (
            <div key={group.label} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {index > 0 ? <span aria-hidden className="text-muted-foreground/40">|</span> : null}
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-muted-foreground transition hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <main id="main" className="container py-6">
        {children}
      </main>
    </div>
  )
}
