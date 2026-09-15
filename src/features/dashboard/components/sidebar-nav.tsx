'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronUp, GripVertical, History, Search, Star, X } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { searchNavItems, type NavItem, type NavSection } from '../nav'
import type { PermissionSubject } from '@/lib/rbac'

/**
 * The body of the sidebar: search, Favorites, Recent, then the full menu.
 *
 * Lifted out of `dashboard-shell.tsx` when it grew the three sections above, and
 * it earns its own file for the same reason the shell rendered one `nav`
 * fragment before: the desktop rail and the mobile sheet are the SAME component
 * with different props, so a change cannot land on one and miss the other.
 *
 * Nothing in here decides a permission. `sections` arrives already filtered by
 * `visibleSections`, and favorites and recents arrive already resolved through
 * it — sidebar.md §7 asks for no second permission system, and the way to keep
 * that promise is for this file to be unable to break it.
 */
export function SidebarNav({
  user,
  sections,
  favorites,
  recent,
  collapsed = false,
  openTasks = 0,
  isActive,
  withBranch,
  onToggleFavorite,
  onMoveFavorite,
  onVisit,
  onExpand,
}: {
  user: PermissionSubject
  /** Already permission-filtered — `visibleSections(user)`. */
  sections: NavSection[]
  /** Already permission-filtered and in the person's own order. */
  favorites: NavItem[]
  /** Already permission-filtered, most recent first, favorites removed. */
  recent: NavItem[]
  collapsed?: boolean
  openTasks?: number
  isActive: (item: NavItem) => boolean
  withBranch: (href: string) => string
  onToggleFavorite: (href: string) => void
  onMoveFavorite: (from: number, to: number) => void
  onVisit: (href: string) => void
  /** Collapsed rail asking to be opened, because search needs a field. */
  onExpand?: () => void
}) {
  const router = useRouter()
  const [term, setTerm] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // A term typed while expanded must not go on filtering an icon-only rail,
  // where there are no labels to filter and no field to clear it in.
  React.useEffect(() => {
    if (collapsed) setTerm('')
  }, [collapsed])

  const query = term.trim()
  const results = React.useMemo(
    () => (query ? searchNavItems(user, query) : []),
    [user, query],
  )

  const favoriteHrefs = React.useMemo(
    () => new Set(favorites.map((item) => item.href)),
    [favorites],
  )

  const go = (href: string) => {
    onVisit(href)
    router.push(withBranch(href))
  }

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setTerm('')
      return
    }
    // Enter follows the best match. Someone who types "waste" and presses Enter
    // has already chosen; making them reach for the mouse to confirm it is the
    // difference between a shortcut and a search box.
    if (event.key === 'Enter') {
      const first = results[0]
      if (!first) return
      event.preventDefault()
      setTerm('')
      go(first.item.href)
    }
  }

  /** One row. Everything below is this with different chrome around it. */
  const row = (
    item: NavItem,
    options: {
      badge?: React.ReactNode
      trailing?: React.ReactNode
      key?: string
      /** Position in the favorites list, when this row is draggable. */
      dragAt?: number
      /**
       * A second line under the label. Used by search results to name the
       * section, which is not decoration: "Reports" and "Approvals" are each
       * the name of two different screens in this menu, so a list of matches
       * without it asks people to pick between two identical rows.
       */
      subtitle?: string
    } = {},
  ) => {
    const active = isActive(item)
    const starred = favoriteHrefs.has(item.href)
    const draggable = options.dragAt !== undefined && !collapsed

    const link = (
      <Link
        // `withBranch`, always. A bare href drops `?branch=` and the page falls
        // back to the cookie, so the switcher reads "All locations" while the
        // figures are one branch's — see the note on `withBranch` in the shell.
        href={withBranch(item.href)}
        onClick={() => onVisit(item.href)}
        className={cn(
          'flex items-center gap-2.5 rounded-lg py-2 text-sm font-medium transition-colors',
          collapsed ? 'justify-center px-2' : 'px-3',
          // Room for the star and the reorder controls, which sit on top of the
          // link rather than inside it — a button inside an anchor is invalid
          // markup, and the browser gives the click to whichever it feels like.
          !collapsed && (draggable ? 'pl-7 pr-[4.5rem]' : 'pr-9'),
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <item.icon className="size-4 shrink-0" />
        {collapsed ? null : options.subtitle ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{item.label}</span>
            <span className="truncate text-[10px] font-normal uppercase tracking-wide opacity-70">
              {options.subtitle}
            </span>
          </span>
        ) : (
          <span className="truncate">{item.label}</span>
        )}
        {options.badge}
      </Link>
    )

    return (
      <li
        key={options.key ?? item.href}
        className="group relative"
        /*
         * Native HTML5 drag, the same shape as the category manager — a ref for
         * the source index, `preventDefault` on dragover to mark a valid drop
         * target, and the move applied on drop. No library: none is installed,
         * and pulling one in for twelve rows that also have buttons would be a
         * dependency to carry for the rest of the project's life.
         */
        draggable={draggable}
        onDragStart={draggable ? () => (dragIndex.current = options.dragAt!) : undefined}
        onDragOver={draggable ? (event) => event.preventDefault() : undefined}
        onDrop={
          draggable
            ? () => {
                const from = dragIndex.current
                dragIndex.current = null
                if (from !== null) onMoveFavorite(from, options.dragAt!)
              }
            : undefined
        }
      >
        {draggable ? (
          <GripVertical className="pointer-events-none absolute left-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        ) : null}

        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        ) : (
          link
        )}

        {collapsed ? null : (
          <span className="absolute inset-y-0 right-1 flex items-center gap-0.5">
            {options.trailing}
            <button
              type="button"
              onClick={() => onToggleFavorite(item.href)}
              aria-pressed={starred}
              aria-label={
                starred
                  ? `Remove ${item.label} from favorites`
                  : `Add ${item.label} to favorites`
              }
              title={starred ? 'Remove from favorites' : 'Add to favorites'}
              className={cn(
                'flex size-6 items-center justify-center rounded-md transition-opacity hover:bg-muted',
                // Hidden until wanted on a pointer device, and always there on a
                // touch screen — there is no hover on a phone, and a control you
                // cannot reveal is a control that does not exist.
                starred
                  ? 'text-primary'
                  : 'text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-lg:opacity-100',
              )}
            >
              <Star className={cn('size-3.5', starred && 'fill-current')} />
            </button>
          </span>
        )}
      </li>
    )
  }

  const tasksBadge = (item: NavItem) =>
    item.href === '/dashboard/tasks' && openTasks > 0 ? (
      <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
        {openTasks > 9 ? '9+' : openTasks}
      </span>
    ) : null

  // ── favorites ──────────────────────────────────────────────────────────────

  const dragIndex = React.useRef<number | null>(null)

  const favoritesBlock =
    favorites.length === 0 ? (
      collapsed ? null : (
        <div>
          <SectionTitle collapsed={collapsed} icon={<Star className="size-3.5" />}>
            Favorites
          </SectionTitle>
          {/*
            Shown once, and then never again for this person. It is the only
            thing that teaches what the star on every row below does, and §10
            wants the owner opening TableFlow to their own work — which cannot
            happen if nobody discovers how to pin any.
          */}
          <p className="px-3 py-1 text-xs text-muted-foreground">
            Star any page to pin it here.
          </p>
        </div>
      )
    ) : (
      <div>
        <SectionTitle collapsed={collapsed} icon={<Star className="size-3.5" />}>
          Favorites
        </SectionTitle>
        <ul className="space-y-0.5">
          {favorites.map((item, index) =>
            row(item, {
              key: `fav-${item.href}`,
              dragAt: index,
              badge: tasksBadge(item),
              trailing: collapsed ? null : (
                <>
                  {/*
                    Buttons as well as drag, and not as a nicety: HTML5 drag
                    events never fire on a touch screen, so on the tablet in the
                    kitchen and the phone in the owner's pocket these are the
                    only way to reorder anything. They are also the only way to
                    do it from a keyboard.
                  */}
                  <button
                    type="button"
                    onClick={() => onMoveFavorite(index, index - 1)}
                    disabled={index === 0}
                    aria-label={`Move ${item.label} up`}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100 max-lg:opacity-100"
                  >
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveFavorite(index, index + 1)}
                    disabled={index === favorites.length - 1}
                    aria-label={`Move ${item.label} down`}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100 max-lg:opacity-100"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                </>
              ),
            }),
          )}
        </ul>
      </div>
    )

  // ── the menu itself ────────────────────────────────────────────────────────

  const searching = query.length > 0

  return (
    <nav className={cn('flex flex-1 flex-col gap-5 overflow-y-auto py-4', collapsed ? 'px-2' : 'px-3')}>
      {/* ── search ──────────────────────────────────────────────────────── */}
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                onExpand?.()
                // After the rail has widened, or the field is not there to focus.
                requestAnimationFrame(() => inputRef.current?.focus())
              }}
              aria-label="Search the menu"
              className="flex items-center justify-center rounded-lg py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Search className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Search the menu</TooltipContent>
        </Tooltip>
      ) : (
        <Input
          ref={inputRef}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search the menu…"
          aria-label="Search the menu"
          startIcon={<Search className="size-4" />}
          endIcon={
            term ? (
              <button
                type="button"
                onClick={() => {
                  setTerm('')
                  inputRef.current?.focus()
                }}
                aria-label="Clear search"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : null
          }
          className="h-9"
        />
      )}

      {searching ? (
        /*
          While searching, Favorites and Recent go away. They are shortcuts to
          things you did not have to look for, and leaving them above a list of
          matches puts two answers to one question on the screen at once.
        */
        results.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing in the menu matches “{query}”.
          </p>
        ) : (
          <div>
            <SectionTitle collapsed={collapsed}>
              {results.length} {results.length === 1 ? 'page' : 'pages'}
            </SectionTitle>
            <ul className="space-y-0.5">
              {results.map(({ item, section }) =>
                row(item, { key: `hit-${item.href}`, subtitle: section }),
              )}
            </ul>
          </div>
        )
      ) : (
        <>
          {favoritesBlock}

          {recent.length > 0 ? (
            <div>
              <SectionTitle collapsed={collapsed} icon={<History className="size-3.5" />}>
                Recent
              </SectionTitle>
              <ul className="space-y-0.5">
                {recent.map((item) =>
                  row(item, { key: `recent-${item.href}`, badge: tasksBadge(item) }),
                )}
              </ul>
            </div>
          ) : null}

          {/*
            The full menu, unchanged and complete. §6: favorites are a shortcut,
            not a filter — nothing is hidden here because it was not starred.
          */}
          {sections.map((section) => (
            <div key={section.title}>
              <SectionTitle collapsed={collapsed}>{section.title}</SectionTitle>
              <ul className="space-y-0.5">
                {section.items.map((item) => row(item, { badge: tasksBadge(item) }))}
              </ul>
            </div>
          ))}
        </>
      )}
    </nav>
  )
}

/**
 * A group heading, or — on the icon rail, where there is no room for words — the
 * rule that would have sat under one. Dropping the heading entirely would run
 * Accounting into Back office with nothing between them.
 */
function SectionTitle({
  children,
  collapsed,
  icon,
}: {
  children: React.ReactNode
  collapsed: boolean
  icon?: React.ReactNode
}) {
  if (collapsed) return <div className="mx-2 mb-1.5 border-t" />
  return (
    <p className="mb-1.5 flex items-center gap-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </p>
  )
}
