'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Building2, Check, ChevronDown, Factory, Store, Warehouse } from 'lucide-react'

const ICONS = {
  BRANCH: Store,
  PRODUCTION_HOUSE: Factory,
  CENTRAL_WAREHOUSE: Warehouse,
} as const

export interface SwitchableLocation {
  id: string
  name: string
  type: keyof typeof ICONS
}

/**
 * The global location switcher, in the top bar on every dashboard page.
 *
 * The choice is written to the URL rather than held in a cookie or context.
 * That way the server components doing the filtering can read it directly, a
 * filtered view can be bookmarked or sent to an accountant, and the back
 * button behaves the way people expect. A cookie would make every one of those
 * quietly wrong.
 *
 * It only renders when there is more than one location, so a single-site
 * restaurant never sees a control that does nothing.
 */
export function BranchSwitcher({ locations }: { locations: SwitchableLocation[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  const current = params.get('branch')
  const active = locations.find((l) => l.id === current) ?? null

  React.useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (locations.length < 2) return null

  const choose = (id: string | null) => {
    const next = new URLSearchParams(params.toString())
    if (id) next.set('branch', id)
    else next.delete('branch')
    setOpen(false)
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const Icon = active ? ICONS[active.type] ?? Building2 : Building2

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm hover:bg-muted"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="max-w-[10rem] truncate">{active ? active.name : 'All locations'}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        >
          <Option label="All locations" icon={Building2} selected={!active} onClick={() => choose(null)} />
          <div className="border-t border-border" />
          {locations.map((l) => (
            <Option
              key={l.id}
              label={l.name}
              hint={l.type !== 'BRANCH' ? l.type.replace(/_/g, ' ').toLowerCase() : undefined}
              icon={ICONS[l.type] ?? Store}
              selected={active?.id === l.id}
              onClick={() => choose(l.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Option({
  label,
  hint,
  icon: Icon,
  selected,
  onClick,
}: {
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {label}
        {hint && <span className="ml-1.5 text-xs text-muted-foreground">{hint}</span>}
      </span>
      {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  )
}
