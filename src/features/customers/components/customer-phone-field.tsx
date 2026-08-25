'use client'

import * as React from 'react'
import { Loader2 } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'
import { suggestCustomersByPhone, type CustomerSuggestion } from '../actions'

/**
 * A phone box that recognises regulars.
 *
 * Type three digits and the customers already on file appear; pick one and the
 * name fills itself in. That is the whole feature — but the reason it matters
 * is not typing speed. `placeOrder` upserts customers on `(restaurantId,
 * phone)` and its update branch overwrites the stored name, so every hurried
 * "Jon" permanently renames a customer saved as "Jonathan Perera". Choosing the
 * existing record is what stops that.
 *
 * ── Notes on the mechanics ─────────────────────────────────────────────────
 *
 * `PopoverAnchor` rather than `PopoverTrigger`: the input must keep focus and
 * keep receiving keystrokes, so it anchors the list without being the thing
 * that opens it. It has to be a portalled popover rather than an absolutely
 * positioned div because on mobile the POS customer fields sit inside a fixed,
 * scrolling `<aside>` that would clip it.
 *
 * The `latest` ref is the stale-response guard: a slow request for "077" must
 * not overwrite the answer for "0771234". Same pattern as the global search
 * box, which is where the 250ms debounce comes from too.
 */
export function CustomerPhoneField({
  phone,
  name,
  onPhoneChange,
  onPick,
  id,
  placeholder = '07X XXX XXXX',
  disabled = false,
}: {
  phone: string
  /** Only used to decide whether picking should overwrite a typed name. */
  name: string
  onPhoneChange: (phone: string) => void
  onPick: (customer: CustomerSuggestion) => void
  id?: string
  placeholder?: string
  disabled?: boolean
}) {
  const [matches, setMatches] = React.useState<CustomerSuggestion[]>([])
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [active, setActive] = React.useState(0)
  /** Suppresses the search that the act of picking would otherwise trigger. */
  const justPicked = React.useRef(false)
  const latest = React.useRef('')

  React.useEffect(() => {
    if (justPicked.current) {
      justPicked.current = false
      return
    }
    const query = phone.trim()
    if (query.length < 3) {
      setMatches([])
      setOpen(false)
      setBusy(false)
      return
    }

    setBusy(true)
    const timer = setTimeout(async () => {
      latest.current = query
      const result = await callAction(() => suggestCustomersByPhone({ term: query }))

      // A slower earlier request must not overwrite a newer answer.
      if (latest.current !== query) return

      setBusy(false)
      if (!result.ok) {
        setMatches([])
        setOpen(false)
        return
      }
      setMatches(result.data.matches)
      setActive(0)
      setOpen(result.data.matches.length > 0)
    }, 250)

    return () => clearTimeout(timer)
  }, [phone])

  const choose = (customer: CustomerSuggestion) => {
    justPicked.current = true
    setOpen(false)
    setMatches([])
    onPick(customer)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || matches.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % matches.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i - 1 + matches.length) % matches.length)
    } else if (event.key === 'Enter') {
      // Only swallow Enter when a suggestion is genuinely highlighted —
      // otherwise this steals the key from the form around it.
      event.preventDefault()
      choose(matches[active])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          id={id}
          inputMode="tel"
          autoComplete="off"
          placeholder={placeholder}
          value={phone}
          disabled={disabled}
          onChange={(e) => onPhoneChange(e.target.value)}
          onKeyDown={onKeyDown}
          endIcon={busy ? <Loader2 className="size-4 animate-spin" /> : null}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-1"
        /*
         * The list must never take focus. A cashier is still typing; stealing
         * the caret to show them a dropdown would make the field unusable.
         */
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ul className="max-h-[40vh] overflow-y-auto">
          {matches.map((customer, index) => (
            <li key={customer.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(customer)}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm ${
                  index === active ? 'bg-muted' : ''
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{customer.name}</span>
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    {customer.phone}
                  </span>
                </span>
                {customer.loyaltyPoints > 0 ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {customer.loyaltyPoints} pts
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {name.trim() ? (
          <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
            Choosing one replaces the name you have typed.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
