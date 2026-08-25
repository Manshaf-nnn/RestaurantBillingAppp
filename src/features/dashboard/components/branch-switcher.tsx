'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  Factory,
  Loader2,
  Settings2,
  Store,
  Warehouse,
} from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/primitives'
import { switchBranch } from '../actions'

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
export function BranchSwitcher({
  locations,
  seesEverything,
}: {
  locations: SwitchableLocation[]
  /**
   * Whether this viewer's reach is genuinely unrestricted —
   * `visibleBranchIds(...) === null`. Decides whether "Main admin" is offered
   * at all, because for anyone else it would be a second name for the one
   * location they already have.
   */
  seesEverything: boolean
}) {
  const pathname = usePathname()
  const params = useSearchParams()
  const [open, setOpen] = React.useState(false)
  /*
   * `useTransition`, not `useAction`.
   *
   * `switchBranch` redirects rather than returning a result — `redirect()`
   * throws a signal the framework catches — so there is no `ActionResult` for
   * `useAction` to inspect. A transition is the pairing that fits: `isPending`
   * stays true across the action AND the navigation it triggers, so the trigger
   * reads "Switching…" until the new branch is actually on screen rather than
   * flicking back to idle halfway.
   */
  const [busy, startSwitch] = React.useTransition()

  const current = params.get('branch')
  const active = locations.find((l) => l.id === current) ?? null

  /*
   * The all-sites row is only offered to somebody who really has all of them.
   *
   * For a manager pinned to one branch, `selectedBranch` resolves "no branch
   * chosen" to `branchIds: [their own branch]` — so the row said "everything
   * added together" and meant "your one site". Two entries, identical figures,
   * one of them lying. A menu that does that teaches people the switcher does
   * nothing.
   *
   * With one location and no all-sites row there is no choice left to make, so
   * the whole control hides — same rule as before, one line further down.
   */
  const rows = locations.length + (seesEverything ? 1 : 0)
  if (rows < 2) return null

  /*
   * One server call, and nothing else.
   *
   * This used to push the new URL from the browser and then ask the router to
   * refresh. It did not work: Next answers a `router.push` from its prefetch
   * cache, whose key drops the query string, so `?branch=A` and `?branch=B`
   * share one entry and the second navigation renders the first one's tree.
   * The URL bar changed and the figures did not. See the note on
   * `switchBranch` for the full mechanism.
   *
   * `switchBranch` writes the cookie, invalidates and redirects on the server,
   * where no client cache can answer. `useAction` keeps `busy` true until the
   * redirect lands, so the trigger shows it is working.
   */
  const choose = (id: string | null) => {
    setOpen(false)
    startSwitch(async () => {
      // action-redirects: `switchBranch` ends in `redirect()`, which throws the
      // signal Next uses to navigate. `callAction` would catch it and report a
      // failure, leaving the page exactly where it was.
      await switchBranch({ branchId: id, path: pathname })
    })
  }

  const Icon = active ? ICONS[active.type] ?? Building2 : Building2

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:opacity-70"
          aria-label="Change location"
          aria-busy={busy}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Icon className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="max-w-[10rem] truncate">
            {busy ? 'Switching…' : active ? active.name : 'Main admin'}
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-0">
        <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Showing figures for
        </p>

        {seesEverything ? (
          <>
            <Row
              label="Main admin"
              hint="Every location, added together"
              icon={Building2}
              selected={!active}
              onSelect={() => choose(null)}
            />
            <div className="my-1 border-t border-border" />
          </>
        ) : null}

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
