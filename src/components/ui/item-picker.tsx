'use client'

import * as React from 'react'
import { Check, ChevronsUpDown, Search, X } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'

/**
 * Choosing one thing out of a long list, by typing (correctionA.md §8).
 *
 * ── Why a component and not a `<select>` with more options ──────────────────
 *
 * Every item picker in this app is a native `<select>`: transfers, production,
 * recipes, purchase orders, goods received, stock counts, wastage. That is the
 * right control for eight options and the wrong one for eight hundred. A
 * kitchen with a real catalogue scrolls a list ordered by name to find
 * "Tomato paste", and on a tablet — where a native select becomes a full-screen
 * wheel — that is the slowest interaction in the product.
 *
 * ── Why it is hand-rolled ───────────────────────────────────────────────────
 *
 * No combobox exists in `components/ui`, and no combobox library is installed.
 * `@radix-ui/react-popover` already is, and is what the branch switcher and the
 * notification bell use, so the portal, the outside-click and the Escape
 * handling come from the primitive this codebase already trusts. What is left
 * is a filtered list and arrow keys, which is small enough to own.
 *
 * ── Accessibility, deliberately minimal but real ────────────────────────────
 *
 * The trigger is a button with the current label. The panel is a `listbox` with
 * `option` children and `aria-selected`; the input owns `aria-activedescendant`
 * so a screen reader follows the arrow keys. It is not a full ARIA 1.2 combobox
 * — that needs focus management this does not attempt — but it is navigable by
 * keyboard alone, which the `<select>` it replaces was too.
 */

export interface PickerOption {
  value: string
  label: string
  /** A second line — a code, a unit, what is free to send. */
  hint?: string
  disabled?: boolean
}

export function ItemPicker({
  options,
  value,
  onChange,
  placeholder = 'Choose…',
  searchPlaceholder = 'Type to search…',
  emptyMessage = 'Nothing matches.',
  disabled,
  id,
  className,
  clearable = false,
}: {
  options: PickerOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  disabled?: boolean
  id?: string
  className?: string
  /** Offers a "clear" row. Off by default — most of these fields are required. */
  clearable?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [term, setTerm] = React.useState('')
  const [active, setActive] = React.useState(0)
  const listId = React.useId()

  const selected = options.find((option) => option.value === value) ?? null

  const matches = React.useMemo(() => {
    const needle = term.trim().toLowerCase()
    if (!needle) return options
    // Label first, then the hint — somebody typing a code is searching the
    // hint, and somebody typing a name is searching the label.
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        (option.hint?.toLowerCase().includes(needle) ?? false),
    )
  }, [options, term])

  // A narrowed list must not leave the highlight past the end of it.
  React.useEffect(() => setActive(0), [term])

  /*
   * The highlighted row follows the keys (recorrection.md §4).
   *
   * Arrow keys moved `active` and nothing moved the list, so on any list
   * longer than the box the highlight walked off the bottom and the person
   * kept pressing Down into rows they could not see. `block: 'nearest'` scrolls
   * only as far as it must, so mouse users hovering a visible row are not
   * yanked about.
   */
  React.useEffect(() => {
    if (!open) return
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open, listId])

  // Opening fresh each time: a stale search term hides the list you just opened.
  React.useEffect(() => {
    if (!open) setTerm('')
  }, [open])

  const choose = (option: PickerOption) => {
    if (option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = matches[active]
      if (option) choose(option)
    }
  }

  return (
    /*
     * `modal`, and this is the whole reason the list scrolls inside a dialog
     * (recorrection.md §4).
     *
     * The list is portalled to <body>, outside the Dialog that opened it, and
     * a Radix Dialog locks scrolling on everything outside itself — so wheel
     * events over this list were swallowed and a picker with more rows than
     * fit was a picker whose lower rows did not exist. Reproduced with 22
     * staff: overflow of 840px, wheel moves nothing. A modal popover owns its
     * own scroll lock; nested locks let the innermost one govern, which is
     * this one.
     */
    <Popover modal open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listId}
          disabled={disabled}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-left text-sm',
            'disabled:cursor-not-allowed disabled:opacity-50',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[--radix-popover-trigger-width] min-w-[15rem] p-0"
      >
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        {/*
          Half the viewport, capped. 16rem was six rows, which on a staff list
          of thirty is a keyhole. Viewport-relative so a phone still gets a
          usable list without the popover running off the bottom of the screen.
        */}
        <ul id={listId} role="listbox" className="max-h-[min(50vh,24rem)] overflow-y-auto overscroll-contain p-1">
          {clearable && !term ? (
            <li>
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                <X className="size-3.5" />
                {placeholder}
              </button>
            </li>
          ) : null}

          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</li>
          ) : (
            matches.map((option, index) => {
              const isSelected = option.value === value
              return (
                <li key={option.value}>
                  <button
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    onClick={() => choose(option)}
                    onMouseEnter={() => setActive(index)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      index === active && 'bg-muted',
                      option.disabled && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Check
                      className={cn('mt-0.5 size-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.hint ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.hint}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
