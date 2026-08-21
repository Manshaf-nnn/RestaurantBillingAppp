'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  Factory,
  Settings2,
  Store,
  Warehouse,
} from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'
import { rememberBranch } from '../actions'

const ICONS = {
  BRANCH: Store,
  PRODUCTION_HOUSE: Factory,
  CENTRAL_WAREHOUSE: Warehouse,
} as const

const TYPE_LABEL: Record<keyof typeof ICONS, string> = {
  BRANCH: 'Branch',
  PRODUCTION_HOUSE: 'Production house',
  CENTRAL_WAREHOUSE: 'Central warehouse',
}

export interface SwitchableLocation {
  id: string
  name: string
  type: keyof typeof ICONS
  managerName?: string | null
  staffCount?: number
}

/**
 * The global location switcher, in the top bar on every dashboard page.
 *
 * ── Why this is a Radix Popover and not a plain div ─────────────────────────
 *
 * It used to be hand-rolled: an `absolute` menu inside the header, and clicking
 * the button appeared to do nothing. The logic was fine — the menu really was
 * rendering — but the header carries `.glass-chrome`, whose
 * `backdrop-filter: blur(22px)` creates its own stacking context and containing
 * block, and an absolutely-positioned descendant of one of those is a
 * long-standing way to paint something the user cannot see.
 *
 * The proof was one element to the right: the notification bell and the avatar
 * menu live in the *same header*, work perfectly, and are Radix — whose
 * `PopoverContent` wraps itself in a Portal and so escapes the header
 * altogether. Using the same primitive removes the whole class of problem
 * rather than guessing at which mechanism it was, and brings Escape, arrow keys
 * and focus handling that the hand-rolled version never had.
 *
 * ── Two jobs, kept separate ─────────────────────────────────────────────────
 *
 * Clicking the **name** changes which location the whole dashboard is showing.
 * Clicking the **↗** opens that location's own page in a new tab. They are
 * genuinely different intentions — "show me Kandy's takings" and "let me look
 * at Kandy" — and collapsing them into one click would mean either losing the
 * filter or opening a tab every time someone changes it.
 *
 * The choice is written to the URL rather than held in context, so the server
 * components doing the filtering can read it directly, a filtered view can be
 * bookmarked or sent to an accountant, and the back button behaves. The cookie
 * alongside it is only a memory of the last choice.
 */
export function BranchSwitcher({ locations }: { locations: SwitchableLocation[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [open, setOpen] = React.useState(false)

  const current = params.get('branch')
  const active = locations.find((l) => l.id === current) ?? null

  if (locations.length < 2) return null

  const choose = (id: string | null) => {
    const next = new URLSearchParams(params.toString())
    if (id) next.set('branch', id)
    else next.delete('branch')
    setOpen(false)

    // Fire and forget: the navigation below is what the user sees, and a failed
    // cookie write should never hold it up or show them an error. The worst case
    // is that tomorrow's first page load says "all locations".
    void callAction(() => rememberBranch(id))

    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)

    /*
     * And then force the page to re-render.
     *
     * `experimental.staleTimes.dynamic` in next.config.mjs keeps a visited page
     * in the client router cache for half a minute — which is what stops the
     * app feeling like it reloads on every sidebar click. The side effect is
     * that switching Kandy → All → Kandy inside that window would be served
     * from the cache with figures that never move, which looks exactly like a
     * broken control. Changing location is precisely the moment the cache must
     * not win.
     */
    router.refresh()
  }

  const Icon = active ? ICONS[active.type] ?? Building2 : Building2

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm transition-colors hover:bg-muted"
          aria-label="Change location"
        >
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="max-w-[10rem] truncate">{active ? active.name : 'All locations'}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-0">
        <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Showing figures for
        </p>

        <Row
          label="All locations"
          hint="Everything added together"
          icon={Building2}
          selected={!active}
          onSelect={() => choose(null)}
        />

        <div className="my-1 border-t border-border" />

        <ul className="max-h-[50vh] overflow-y-auto">
          {locations.map((l) => (
            <li key={l.id}>
              <Row
                label={l.name}
                hint={[
                  TYPE_LABEL[l.type] ?? 'Location',
                  l.managerName ?? 'No manager',
                  l.staffCount ? `${l.staffCount} staff` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                icon={ICONS[l.type] ?? Store}
                selected={active?.id === l.id}
                onSelect={() => choose(l.id)}
                /*
                 * A new tab, deliberately. You are usually looking a location up
                 * *while* doing something else — checking what Kandy holds
                 * before approving their transfer — and losing the page you were
                 * on would be the wrong trade.
                 */
                openHref={`/dashboard/locations/${l.id}`}
              />
            </li>
          ))}
        </ul>

        <div className="border-t border-border">
          <Link
            href="/dashboard/locations"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Settings2 className="h-4 w-4" />
            Manage locations
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Row({
  label,
  hint,
  icon: Icon,
  selected,
  onSelect,
  openHref,
}: {
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  selected: boolean
  onSelect: () => void
  /** When set, an ↗ that opens this location in a new tab. */
  openHref?: string
}) {
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {hint ? (
            <span className="block truncate text-xs text-muted-foreground">{hint}</span>
          ) : null}
        </span>
        {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
      </button>

      {openHref ? (
        <Link
          href={openHref}
          target="_blank"
          rel="noreferrer"
          title={`Open ${label} in a new tab`}
          aria-label={`Open ${label} in a new tab`}
          className="flex w-10 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      ) : null}
    </div>
  )
}
