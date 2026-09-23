'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Eye } from 'lucide-react'

import { Alert } from '@/components/ui/feedback'
import { useCart } from '@/features/orders/cart-store'
import { resolveTable } from '@/features/orders/actions'
import type { GuestAppearance } from '@/features/guest/appearance'
import {
  GuestCover,
  GuestPrompt,
  GuestSubmit,
  useBrandAccent,
} from '@/features/guest/components/guest-cover'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { enterQrExperience } from '../actions'
import { qrPath } from '../guest-path'

/**
 * The entry screen for a QR menu (ar.md §5, §6, §7, §20).
 *
 * The same `GuestCover` the ordinary table QR lands on, so a guest meets the
 * same restaurant whichever card they scanned. What differs is only what this
 * card asks — and that is what the owner configures.
 *
 * ── Order of questions: table, then who you are, then the menu ──────────────
 *
 * The table is resolved first because it can be refused: somebody else is
 * sitting there, or it is held for a booking. Asking it first means a guest
 * who is turned away never had a customer record written for them — a row in
 * the CRM for a visit that never happened.
 *
 * ── A code with no table ────────────────────────────────────────────────────
 *
 * A delivery leaflet or a takeaway counter has no table to ask about, so
 * `askTable` is off and the question is simply not there. The order that
 * follows is a TAKEAWAY, and the branch comes from the code rather than from
 * a table nobody sat at.
 */

export interface EntryField {
  key: string
  label: string
  type: 'TEXT' | 'PHONE' | 'EMAIL' | 'DATE' | 'NUMBER'
  rule: 'OPTIONAL' | 'REQUIRED'
  categoryId: string | null
}

export interface EntryCategory {
  id: string
  name: string
  colour: string | null
}

const INPUT_TYPE: Record<EntryField['type'], string> = {
  TEXT: 'text',
  PHONE: 'tel',
  EMAIL: 'email',
  DATE: 'date',
  NUMBER: 'number',
}

export function QrEntry({
  code,
  slug,
  branchCode,
  restaurantName,
  tagline,
  logoUrl,
  coverUrl,
  isOpen,
  openingLabel,
  appearance,
  askTable,
  ordering,
  identify,
  askCategory,
  categories,
  fields,
  initialTable,
  preview,
}: {
  code: string
  slug: string
  branchCode: string
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  isOpen: boolean
  openingLabel: string | null
  appearance: GuestAppearance
  /** False for a delivery or takeaway code — there is no table to ask about. */
  askTable: boolean
  /** False for a menu-only code: nothing is seated and nothing is ordered. */
  ordering: boolean
  identify: boolean
  askCategory: boolean
  categories: EntryCategory[]
  fields: EntryField[]
  initialTable: string
  preview: boolean
}) {
  const router = useRouter()
  const { setTable, setCustomer } = useCart()
  const accent = useBrandAccent(logoUrl, coverUrl)

  const wantsTable = ordering && askTable

  const [tableNumber, setTableNumber] = React.useState(initialTable)
  const [focused, setFocused] = React.useState(false)
  const [categoryId, setCategoryId] = React.useState<string | null>(
    askCategory && categories.length === 1 ? categories[0].id : null,
  )
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [unavailable, setUnavailable] = React.useState<{ tableNumber: string; reason: string } | null>(null)
  const [ownOrder, setOwnOrder] = React.useState<{ id: string; orderNumber: string; editable: boolean } | null>(null)

  const menuHref = qrPath(code, 'menu')

  /*
   * Which questions are on screen right now (ar.md §7).
   *
   * Everything with no category, plus the extras belonging to the category
   * just chosen — and nothing belonging to a category that was not. A
   * category-specific row replaces the general one with the same key, so
   * "phone optional generally, required for VIP" is one box, not two.
   */
  const visible = React.useMemo(() => {
    const general = fields.filter((field) => field.categoryId === null)
    const specific = categoryId ? fields.filter((field) => field.categoryId === categoryId) : []
    const overridden = new Set(specific.map((field) => field.key))
    return [...general.filter((field) => !overridden.has(field.key)), ...specific]
  }, [fields, categoryId])

  const needsCategory = askCategory && categories.length > 0 && !categoryId
  const missing = visible.find((field) => field.rule === 'REQUIRED' && !(answers[field.key] ?? '').trim())

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setUnavailable(null)
    setOwnOrder(null)

    if (needsCategory) { setError('Choose one to carry on'); return }
    if (missing) { setError(`${missing.label} is needed`); return }
    if (wantsTable && !tableNumber.trim()) { setError('Enter the number printed on your table'); return }

    setPending(true)
    try {
      // 1. The table, when there is one to ask about.
      if (wantsTable && !preview) {
        const table = await callAction(() =>
          resolveTable({ tableNumber: tableNumber.trim() }, slug, branchCode),
        )
        if (!table.ok) { setError(table.error); return }
        const seat = table.data
        if (seat.ownOrder) {
          setOwnOrder(seat.ownOrder)
          setTable(seat)
          return
        }
        if (seat.state !== 'AVAILABLE') {
          setUnavailable({
            tableNumber: seat.tableNumber,
            reason: seat.reason ?? `Table ${seat.tableNumber} is currently unavailable`,
          })
          return
        }
        setTable(seat)
      }

      // 2. Who they are — straight into the existing CRM.
      if (identify && !preview) {
        const entered = await callAction(() => enterQrExperience({ code, categoryId, answers }))
        if (!entered.ok) { setError(entered.error); return }
        /*
         * The CANONICAL stored name and phone, not what was just typed.
         *
         * `placeOrder` upserts by the exact phone string and overwrites the
         * name every time, so a regular called "Jonathan Perera" who types
         * "Jon" here would be renamed for good — and a blank name would
         * rewrite them to "Guest". Carrying back what the CRM actually holds
         * makes that overwrite a no-op, and is also what lets the checkout
         * find them so a category-targeted offer applies.
         */
        if (entered.data.customerPhone) {
          setCustomer({ name: entered.data.customerName, phone: entered.data.customerPhone })
        } else if (answers.name) {
          setCustomer({ name: answers.name })
        }
      }

      router.push(preview ? `${menuHref}?preview=1` : menuHref)
    } finally {
      setPending(false)
    }
  }

  const heading = wantsTable ? appearance.headingText : appearance.noTableHeadingText
  const helper = wantsTable ? appearance.helperText : appearance.noTableHelperText

  return (
    <GuestCover
      restaurantName={restaurantName}
      tagline={tagline}
      logoUrl={logoUrl}
      coverUrl={coverUrl}
      isOpen={isOpen}
      openingLabel={openingLabel}
      appearance={appearance}
      sampled={accent}
    >
      {preview ? (
        <p className="guest-surface mt-3 flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] font-semibold text-amber-400">
          <Eye className="size-3.5" />
          Preview — nothing here is saved
        </p>
      ) : null}

      <GuestPrompt heading={heading} helper={helper} />

      <form onSubmit={submit} className="mt-3.5 space-y-2.5">
        {wantsTable ? (
          <div
            className={cn(
              'guest-control relative flex h-14 items-center rounded-xl border px-3.5 transition-all duration-300',
              focused
                ? 'border-amber-500/80 ring-4 ring-amber-500/20 shadow-[0_0_28px_rgba(249,115,22,0.28)]'
                : tableNumber.length > 0
                  ? 'border-amber-500/55 shadow-[0_0_18px_rgba(249,115,22,0.18)]'
                  : '',
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-black/5 text-amber-500 dark:border-white/10 dark:bg-white/5 dark:text-amber-400">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h18" /><path d="M5 7v13" /><path d="M19 7v13" />
                <path d="M8 12h8" /><path d="M12 7v5" />
              </svg>
            </div>
            <div className="guest-divider mx-3 h-6 w-px shrink-0" />
            <input
              value={tableNumber}
              onChange={(event) => { setTableNumber(event.target.value.toUpperCase().slice(0, 10)); setError(null) }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              inputMode="numeric"
              placeholder="5"
              aria-label="Table number"
              className="guest-ink w-full bg-transparent text-center text-2xl font-extrabold tracking-wider outline-none placeholder:opacity-40"
            />
          </div>
        ) : null}

        {askCategory && categories.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => { setCategoryId(category.id); setError(null) }}
                aria-pressed={categoryId === category.id}
                className={cn(
                  'guest-control rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all',
                  categoryId === category.id
                    ? 'border-amber-500/70 bg-amber-500/10 text-amber-400 shadow-[0_0_18px_rgba(249,115,22,0.18)]'
                    : 'guest-ink-muted',
                )}
              >
                {category.colour ? (
                  <span
                    className="mr-1.5 inline-block size-2 rounded-full align-middle"
                    style={{ backgroundColor: category.colour }}
                  />
                ) : null}
                {category.name}
              </button>
            ))}
          </div>
        ) : null}

        {identify
          ? visible.map((field) => (
              <div key={`${field.key}-${field.categoryId ?? 'all'}`} className="guest-control flex h-12 items-center rounded-xl border px-3.5">
                <label
                  htmlFor={`qr-${field.key}`}
                  className="guest-ink-muted w-28 shrink-0 text-left text-[11px] font-semibold"
                >
                  {field.label}
                  {field.rule === 'REQUIRED' ? <span className="ml-0.5 text-amber-500">*</span> : null}
                </label>
                <div className="guest-divider mx-2 h-5 w-px shrink-0" />
                <input
                  id={`qr-${field.key}`}
                  type={INPUT_TYPE[field.type]}
                  inputMode={field.type === 'PHONE' ? 'tel' : field.type === 'NUMBER' ? 'numeric' : undefined}
                  value={answers[field.key] ?? ''}
                  onChange={(event) => {
                    setAnswers((current) => ({ ...current, [field.key]: event.target.value.slice(0, 200) }))
                    setError(null)
                  }}
                  autoComplete={
                    field.key === 'name' ? 'name' : field.key === 'phone' ? 'tel' : field.key === 'email' ? 'email' : 'off'
                  }
                  className="guest-ink w-full bg-transparent text-left text-sm font-semibold outline-none placeholder:opacity-40"
                  placeholder={field.rule === 'REQUIRED' ? 'Required' : 'Optional'}
                />
              </div>
            ))
          : null}

        {error ? (
          <Alert variant="destructive" className="border-red-500/50 bg-red-950/80 py-1.5 text-center text-xs text-red-200">
            {error}
          </Alert>
        ) : null}

        {unavailable ? (
          <div className="guest-surface rounded-xl border px-3 py-2.5 text-center" role="status">
            <p className="guest-ink text-sm font-semibold">Table {unavailable.tableNumber} is currently unavailable</p>
            <p className="guest-ink-muted mt-0.5 text-[11px]">{unavailable.reason}. Please ask our staff for a table.</p>
          </div>
        ) : null}

        {ownOrder ? (
          <div className="guest-surface rounded-xl border px-3 py-2.5 text-center" role="status">
            <p className="guest-ink text-sm font-semibold">You already have an order at this table</p>
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

        <GuestSubmit label={appearance.buttonText} pending={pending} pendingLabel="Just a moment…" />
      </form>
    </GuestCover>
  )
}
