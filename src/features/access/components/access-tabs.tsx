import Link from 'next/link'

/**
 * Role &amp; Access is one place with two halves (staff.A.md §8).
 *
 * Roles are the templates; Staff are the people on them. They were two sidebar
 * entries with nothing between them, so an owner who had just built a role had
 * no way to go and put somebody in it except back through the menu — and the
 * spec asks for the pair explicitly.
 *
 * A server component with plain links rather than client-side tabs: these are
 * two different pages with two different queries, and pretending otherwise
 * would mean loading both to show one.
 */
export function AccessTabs({ active }: { active: 'roles' | 'staff' }) {
  const tabs = [
    { key: 'roles' as const, href: '/dashboard/roles', label: 'Roles' },
    { key: 'staff' as const, href: '/dashboard/staff', label: 'Staff' },
  ]
  return (
    <nav aria-label="Role and access" className="mb-4 inline-flex rounded-lg border p-0.5">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? 'page' : undefined}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            active === tab.key
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
