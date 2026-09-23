"use client"

import React, { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { resolveTable } from '@/features/orders/actions'
import { guestPath } from '@/features/orders/guest-path'
import { useCart } from '@/features/orders/cart-store'
import { DEFAULT_APPEARANCE, type GuestAppearance } from '@/features/guest/appearance'
import {
  GuestCover,
  GuestPrompt,
  GuestSubmit,
  useBrandAccent,
} from '@/features/guest/components/guest-cover'

interface Props {
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  city: string | null
  isOpen: boolean
  openingLabel: string | null
  /** From a table QR — the guest then types nothing at all. */
  initialTable?: string
  /** The restaurant slug, so every link from here keeps the branch. */
  slug?: string
  /**
   * The branch code the QR carried.
   *
   * Passed to `resolveTable` so "table 1" means table 1 AT THIS BRANCH. Table
   * numbers restart per branch, and the lookup used to search by number alone
   * — so a guest at Branch 01 was seated at Main's table 1 and their order
   * printed in Main's kitchen.
   */
  branchCode?: string | null
  /** Named when it is not the main site, so a guest can see they scanned right. */
  branchName?: string | null
  /** What the owner has decided this screen shows and says (ar.md §13). */
  appearance?: GuestAppearance
}

/**
 * The QR landing screen: ask for the table, then the menu.
 *
 * Everything about how this LOOKS now lives in `GuestCover`, which the QR-menu
 * entry screen renders too — the owner's requirement is that a guest meets the
 * same restaurant whichever card they scanned, and two components that must
 * look identical are two components that drift. What is left here is this
 * screen's own question and what happens when it is answered.
 */
export default function CoverPage(props: Props) {
  const router = useRouter()
  const { setTable } = useCart()
  const appearance = props.appearance ?? DEFAULT_APPEARANCE
  const accent = useBrandAccent(props.logoUrl, props.coverUrl)

  const [tableNumber, setTableNumber] = useState(props.initialTable ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The table cannot be ordered at right now (aO.md §2); what the server said. */
  const [unavailable, setUnavailable] = useState<{ tableNumber: string; reason: string } | null>(null)
  /** This guest already has an order at the table: take them to it. */
  const [ownOrder, setOwnOrder] = useState<{ tableNumber: string; id: string; orderNumber: string; editable: boolean } | null>(null)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const menuHref = props.slug && props.branchCode ? guestPath(props.slug, props.branchCode, 'menu') : '/order/menu'

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setUnavailable(null)
    setOwnOrder(null)

    const trimmed = tableNumber.trim()
    if (!trimmed) { setError('Enter the number printed on your table'); return }
    setPending(true)
    try {
      const result = await resolveTable({ tableNumber: trimmed }, props.slug, props.branchCode)
      if (!result.ok) { setError(result.error); return }
      const session = result.data

      /*
       * The server decides whether this table can be ordered at (aO.md §2).
       * Their own open order wins over "occupied": it is their table.
       */
      const mine = session.ownOrder
      if (mine) {
        setOwnOrder({ tableNumber: session.tableNumber, ...mine })
        setTable(session)
        return
      }
      if (session.state !== 'AVAILABLE') {
        const reason = session.reason
        setUnavailable({ tableNumber: session.tableNumber, reason: reason ?? `Table ${session.tableNumber} is currently unavailable` })
        return
      }

      setTable(session)
      toast.success(`Table ${session.tableNumber} — welcome!`)
      /*
       * The branch travels in the path from here on. It used to be dropped, so
       * a guest correctly seated at Branch 02 browsed Main's menu at Main's
       * prices with nothing on screen to say so.
       */
      router.push(menuHref)
    } finally {
      setPending(false)
    }
  }

  return (
    <GuestCover
      restaurantName={props.restaurantName}
      tagline={props.tagline}
      logoUrl={props.logoUrl}
      coverUrl={props.coverUrl}
      isOpen={props.isOpen}
      openingLabel={props.openingLabel}
      appearance={appearance}
      sampled={accent}
    >
      <GuestPrompt heading={appearance.headingText} helper={appearance.helperText} />

      <form onSubmit={submit} className="mt-3.5">
        <div
          className={`guest-control relative flex h-14 items-center rounded-xl border px-3.5 transition-all duration-300 ${
            focused
              ? 'border-amber-500/80 ring-4 ring-amber-500/20 shadow-[0_0_28px_rgba(249,115,22,0.28)]'
              : tableNumber.length > 0
                ? 'border-amber-500/55 shadow-[0_0_18px_rgba(249,115,22,0.18)]'
                : ''
          }`}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-black/5 text-amber-500 dark:border-white/10 dark:bg-white/5 dark:text-amber-400">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h18" /><path d="M5 7v13" /><path d="M19 7v13" />
              <path d="M8 12h8" /><path d="M12 7v5" />
            </svg>
          </div>
          <div className="guest-divider mx-3 h-6 w-px shrink-0" />
          <input
            ref={inputRef}
            value={tableNumber}
            onChange={(e) => { setTableNumber(e.target.value.toUpperCase().slice(0, 10)); setError(null) }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            inputMode="numeric"
            placeholder="5"
            aria-label="Table number"
            aria-describedby={error ? 'table-error' : undefined}
            className="guest-ink w-full bg-transparent text-center text-2xl font-extrabold tracking-wider outline-none placeholder:opacity-40"
          />
        </div>

        {error && (
          <div className="mt-2.5" id="table-error">
            <Alert variant="destructive" className="text-center bg-red-950/80 border-red-500/50 text-red-200 py-1.5 text-xs">
              {error}
            </Alert>
          </div>
        )}

        {unavailable ? (
          <div className="guest-surface mt-2.5 rounded-xl border px-3 py-2.5 text-center" role="status" data-testid="table-unavailable">
            <p className="guest-ink text-sm font-semibold">Table {unavailable.tableNumber} is currently unavailable</p>
            <p className="guest-ink-muted mt-0.5 text-[11px]">{unavailable.reason}. Please ask our staff for a table.</p>
          </div>
        ) : null}

        {ownOrder ? (
          <div className="guest-surface mt-2.5 rounded-xl border px-3 py-2.5 text-center" role="status" data-testid="table-own-order">
            <p className="guest-ink text-sm font-semibold">You already have an order at table {ownOrder.tableNumber}</p>
            <p className="guest-ink-muted mt-0.5 text-[11px]">Order {ownOrder.orderNumber}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => router.push(`/order/track/${ownOrder.id}`)}
                className="rounded-lg border border-amber-500/60 bg-amber-500/10 py-2 text-xs font-bold text-amber-500"
              >
                View your order
              </button>
              <button
                type="button"
                onClick={() => router.push(ownOrder.editable ? `${menuHref}?add=${ownOrder.id}` : menuHref)}
                className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 py-2 text-xs font-bold text-white"
              >
                {ownOrder.editable ? 'Add more items' : 'Order more'}
              </button>
            </div>
          </div>
        ) : null}

        <GuestSubmit label={appearance.buttonText} pending={pending} pendingLabel="Verifying Table…" />
      </form>
    </GuestCover>
  )
}
