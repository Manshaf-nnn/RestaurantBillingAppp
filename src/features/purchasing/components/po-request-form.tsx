'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { StockUnit } from '@prisma/client'
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  Flag,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Truck,
  UserRound,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { LocalDateTime } from '@/components/local-time'
import { toBaseUnits } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { createPurchaseOrderAction, updatePurchaseOrderAction } from '../actions'
import type { PoBuilderData } from '../queries'
import { PO_PRIORITY, PO_STATUS, formatPercent, priceChange } from '../status'
import { ItemAvatar, ItemPricePanel, PRICE_ALERT_ABOVE } from './item-price-panel'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const
const PRIORITIES = ['LOW', 'NORMAL', 'URGENT'] as const

interface Line {
  key: string
  itemId: string
  quantity: string
  unit: string
  /** Major units, as typed. */
  unitCost: string
}

export interface PoEditTarget {
  purchaseId: string
  number: string
  status: string
  supplierId: string | null
  branchId: string | null
  expectedAt: string | null
  priority: string
  notes: string | null
  discount: number
  taxTotal: number
  lines: Array<{ itemId: string; quantity: number; unit: string | null; unitCost: number }>
}

/**
 * The purchase order request.
 *
 * Header → items → last price → notes → estimated total → save or submit,
 * in that order, because that is the order somebody raising one thinks in.
 *
 * Choosing an item fills in its last purchase price where there is one — the
 * number a buyer is actually checking against — and the supplier's standing
 * quote otherwise. It stays editable: the request records what is being
 * asked for now, not what was paid last time. A price well above the last
 * one is flagged on the line and explained in the panel; it is never blocked,
 * because the supplier's new price is a fact the request has to be able to
 * carry.
 *
 * `prefill` carries items straight from the reorder suggestions, which is the
 * path most requests will take: see what is low, order it.
 */
export function PoRequestForm({
  data,
  prefill,
  editing,
  requestedBy,
  defaultBranchId,
  canSubmit,
}: {
  data: PoBuilderData
  prefill?: Array<{ itemId: string; quantity: number }>
  editing?: PoEditTarget
  /** Who is raising it — shown in the header as the requester. */
  requestedBy: string
  /** The location the switcher is on, for a new request. */
  defaultBranchId?: string | null
  /** Holds `purchase.create`. Without it the form is read-only. */
  canSubmit: boolean
}) {
  const router = useRouter()
  const currency = data.currency as CurrencyCode
  const factor = minorUnitFactor(currency)
  const money = (minor: number) => formatMoney(minor, currency)
  const itemById = React.useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items])

  /** Base units in one of the line's units, or null when the item cannot say. */
  const basePerUnit = React.useCallback(
    (itemId: string, unit: string): number | null => {
      const item = itemById.get(itemId)
      if (!item) return null
      if (unit === item.unit) return 1
      try {
        return toBaseUnits(1, unit as StockUnit, {
          name: item.name,
          unit: item.unit as StockUnit,
          purchaseUnit: (item.purchaseUnit ?? null) as StockUnit | null,
          unitsPerPurchaseUnit: item.unitsPerPurchaseUnit ?? null,
        })
      } catch {
        return null
      }
    },
    [itemById],
  )

  /** The last paid price per the line's own unit, minor units. */
  const lastPriceFor = React.useCallback(
    (itemId: string, unit: string): number | null => {
      const item = itemById.get(itemId)
      if (!item?.lastPurchase) return null
      const per = basePerUnit(itemId, unit)
      return per === null ? null : Math.round(item.lastPurchase.unitCost * per)
    },
    [itemById, basePerUnit],
  )

  /** A new line, priced from what was last paid, then the preferred supplier. */
  const lineFor = React.useCallback(
    (itemId: string, quantity = '', key?: string): Line => {
      const item = itemById.get(itemId)
      const source = item?.sources[0]
      const unit = source?.purchaseUnit ?? item?.purchaseUnit ?? item?.unit ?? 'PIECE'
      const last = lastPriceFor(itemId, unit)
      const cost = last ?? source?.price ?? item?.fallbackCost ?? 0
      return {
        key: key ?? `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        itemId,
        quantity,
        unit,
        unitCost: cost ? String(cost / factor) : '',
      }
    },
    [itemById, lastPriceFor, factor],
  )

  const [branchId, setBranchId] = React.useState(
    () =>
      editing?.branchId ??
      defaultBranchId ??
      data.locations.find((l) => l.isDefault)?.id ??
      data.locations[0]?.id ??
      '',
  )
  const [supplierId, setSupplierId] = React.useState(() => {
    if (editing) return editing.supplierId ?? ''
    if (!prefill?.length) return ''
    const tally = new Map<string, number>()
    for (const row of prefill) {
      const source = itemById.get(row.itemId)?.sources[0]
      if (source) tally.set(source.supplierId, (tally.get(source.supplierId) ?? 0) + 1)
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  })
  const [expectedAt, setExpectedAt] = React.useState(editing?.expectedAt?.slice(0, 10) ?? '')
  const [priority, setPriority] = React.useState(editing?.priority ?? 'NORMAL')
  const [notes, setNotes] = React.useState(editing?.notes ?? '')
  const [lines, setLines] = React.useState<Line[]>(() => {
    if (editing) {
      // The saved values, not re-derived ones: a request records what was
      // asked, and re-pricing it on open would change the thing someone is
      // only correcting a typo in.
      return editing.lines.map((row, i) => ({
        key: `edit-${i}`,
        itemId: row.itemId,
        quantity: String(row.quantity),
        unit: row.unit ?? itemById.get(row.itemId)?.unit ?? 'PIECE',
        unitCost: String(row.unitCost / factor),
      }))
    }
    return prefill?.length
      ? prefill.map((row, i) => lineFor(row.itemId, String(row.quantity), `pre-${i}`))
      : []
  })
  const [search, setSearch] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [activeMatch, setActiveMatch] = React.useState(0)
  const [panelFor, setPanelFor] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'draft' | 'submit' | null>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const onLine = React.useMemo(() => new Set(lines.map((l) => l.itemId)), [lines])
  const matches = React.useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return []
    return data.items
      .filter(
        (item) =>
          !onLine.has(item.id) &&
          (item.name.toLowerCase().includes(needle) ||
            (item.sku?.toLowerCase().includes(needle) ?? false)),
      )
      .slice(0, 8)
  }, [data.items, search, onLine])

  React.useEffect(() => setActiveMatch(0), [search])

  const addItem = (itemId: string) => {
    setLines((current) => [...current, lineFor(itemId, '1')])
    setSearch('')
    setSearchOpen(false)
    searchRef.current?.focus()
  }

  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const stockFor = (itemId: string) => {
    const item = itemById.get(itemId)
    if (!item) return null
    const at = branchId ? item.stockByBranch[branchId] : undefined
    return { quantity: at ?? item.quantity, unit: item.unit.toLowerCase(), local: at !== undefined }
  }

  const lineTotal = (line: Line) => {
    const q = Number(line.quantity)
    const c = Number(line.unitCost)
    return Number.isFinite(q) && Number.isFinite(c) ? Math.round(q * c * factor) : 0
  }
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0)

  const panelLine = panelFor ? lines.find((l) => l.itemId === panelFor) ?? null : null
  const panelEntered =
    panelLine && Number(panelLine.unitCost) > 0
      ? (() => {
          const per = basePerUnit(panelLine.itemId, panelLine.unit)
          return per ? Math.round((Number(panelLine.unitCost) * factor) / per) : null
        })()
      : null

  const save = async (submit: boolean) => {
    const payload = lines
      .filter((l) => l.itemId && Number(l.quantity) > 0)
      .map((l) => ({
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unit: l.unit,
        unitCost: Number(l.unitCost) || 0,
      }))
    if (payload.length === 0) {
      toast.error('Add at least one item with a quantity')
      return
    }
    if (!branchId) {
      toast.error('Choose the location this is for')
      return
    }

    setBusy(submit ? 'submit' : 'draft')
    const body = {
      supplierId,
      branchId,
      expectedAt,
      priority,
      notes,
      discount: editing ? editing.discount / factor : 0,
      taxTotal: editing ? editing.taxTotal / factor : 0,
      lines: payload,
      submit,
    }
    const result = await callAction(() =>
      editing
        ? updatePurchaseOrderAction({ purchaseId: editing.purchaseId, ...body })
        : createPurchaseOrderAction(body),
    )
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const id = editing ? editing.purchaseId : (result.data as { id: string }).id
    toast.success(submit ? 'Sent for approval' : editing ? 'Request saved' : 'Draft saved')
    router.push(`/dashboard/purchases/${id}`)
  }

  const status = editing ? PO_STATUS[editing.status as keyof typeof PO_STATUS] : PO_STATUS.DRAFT
  const editingPending = editing?.status === 'PENDING_APPROVAL'

  return (
    <div className="space-y-4">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tabular-nums">{editing?.number ?? 'New request'}</h2>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right">
              <p className="text-[11px] text-muted-foreground">Requested by</p>
              <p className="font-medium">
                <UserRound className="mr-1 inline size-3.5 text-muted-foreground" />
                {requestedBy}
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <LocalDateTime value={new Date().toISOString()} />
            </div>
          </div>
        </div>

        <div className="grid gap-3 border-t px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field icon={<Building2 />} label="Location" htmlFor="po-branch">
            <select
              id="po-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className={SELECT}
              disabled={!canSubmit}
            >
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field icon={<Truck />} label="Supplier" htmlFor="po-supplier">
            <select
              id="po-supplier"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className={SELECT}
              disabled={!canSubmit}
            >
              <option value="">Optional</option>
              {data.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field icon={<CalendarDays />} label="Required date" htmlFor="po-required">
            <Input
              id="po-required"
              type="date"
              value={expectedAt}
              onChange={(e) => setExpectedAt(e.target.value)}
              disabled={!canSubmit}
            />
          </Field>
          <Field icon={<Flag />} label="Priority" htmlFor="po-priority">
            <select
              id="po-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className={SELECT}
              disabled={!canSubmit}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PO_PRIORITY[p].label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      {/* ── items ──────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card shadow-soft">
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <div className="relative min-w-0 flex-1">
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setSearchOpen(true)
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 120)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActiveMatch((i) => (matches.length ? (i + 1) % matches.length : 0))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveMatch((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const hit = matches[activeMatch]
                  if (hit) addItem(hit.id)
                } else if (e.key === 'Escape') {
                  setSearchOpen(false)
                }
              }}
              placeholder="Search item or scan barcode…"
              aria-label="Search items"
              startIcon={<Search className="size-4" />}
              disabled={!canSubmit}
            />
            {searchOpen && search.trim() ? (
              <ul
                role="listbox"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-elevated"
              >
                {matches.length === 0 ? (
                  <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                    {onLine.size > 0 ? 'Nothing else matches.' : 'Nothing matches.'}
                  </li>
                ) : (
                  matches.map((item, index) => {
                    const stock = item.stockByBranch[branchId] ?? item.quantity
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === activeMatch}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setActiveMatch(index)}
                          onClick={() => addItem(item.id)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm',
                            index === activeMatch && 'bg-muted',
                          )}
                        >
                          <ItemAvatar name={item.name} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{item.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {[item.sku, `${stock} ${item.unit.toLowerCase()} in stock`].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          {item.lastPurchase ? (
                            <span className="text-xs tabular-nums text-success">
                              {money(item.lastPurchase.unitCost)}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })
                )}
              </ul>
            ) : null}
          </div>
          <Button type="button" onClick={() => searchRef.current?.focus()} disabled={!canSubmit}>
            <Plus /> Add item
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Item</th>
                <th className="px-3 py-2.5 font-medium">Current stock</th>
                <th className="px-3 py-2.5 font-medium">Qty</th>
                <th className="px-3 py-2.5 font-medium">Unit</th>
                <th className="px-3 py-2.5 font-medium">Last price</th>
                <th className="px-3 py-2.5 font-medium">Price</th>
                <th className="px-3 py-2.5 text-right font-medium">Total</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-sm text-muted-foreground">
                    Nothing on this request yet. Search above to add an item.
                  </td>
                </tr>
              ) : (
                lines.map((line) => {
                  const item = itemById.get(line.itemId)
                  if (!item) return null
                  const stock = stockFor(line.itemId)
                  const last = lastPriceFor(line.itemId, line.unit)
                  const typed = Math.round((Number(line.unitCost) || 0) * factor)
                  const change = last !== null && typed > 0 ? priceChange(last, typed) : 0
                  const dearer = last !== null && typed > 0 && change > PRICE_ALERT_ABOVE
                  return (
                    <tr key={line.key} className="align-middle">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <ItemAvatar name={item.name} />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{item.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {item.lastPurchase ? (
                                <>
                                  Last: <LocalDateTime value={item.lastPurchase.at} />
                                  {item.lastPurchase.supplierName ? ` · ${item.lastPurchase.supplierName}` : ''}
                                </>
                              ) : (
                                'No previous purchase'
                              )}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        {stock ? (
                          <span title={stock.local ? 'At this location' : 'Across all locations'}>
                            {stock.quantity} {stock.unit}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <Input
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(e) => update(line.key, { quantity: e.target.value })}
                          className="h-9 w-20 text-right tabular-nums"
                          aria-label={`Quantity of ${item.name}`}
                          disabled={!canSubmit}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <select
                          value={line.unit}
                          onChange={(e) => update(line.key, { unit: e.target.value })}
                          className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                          aria-label={`Unit of ${item.name}`}
                          disabled={!canSubmit}
                        >
                          {UNITS.map((u) => (
                            <option key={u} value={u}>
                              {u.toLowerCase()}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        {last !== null ? (
                          <div>
                            <p className="font-medium tabular-nums text-success">{money(last)}</p>
                            <button
                              type="button"
                              onClick={() => setPanelFor(line.itemId)}
                              className="text-xs text-primary underline-offset-2 hover:underline"
                            >
                              View
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPanelFor(line.itemId)}
                            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                          >
                            None yet
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="relative">
                          <Input
                            inputMode="decimal"
                            value={line.unitCost}
                            onChange={(e) => update(line.key, { unitCost: e.target.value })}
                            className={cn('h-9 w-28 text-right tabular-nums', dearer && 'border-destructive pr-7')}
                            aria-label={`Price of ${item.name}`}
                            disabled={!canSubmit}
                          />
                          {dearer ? (
                            <button
                              type="button"
                              onClick={() => setPanelFor(line.itemId)}
                              title={`${formatPercent(change)} against the last purchase`}
                              aria-label="Price is higher than the last purchase — see why"
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-destructive"
                            >
                              <AlertTriangle className="size-4" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-medium tabular-nums">{money(lineTotal(line))}</td>
                      <td className="px-3 py-3 text-right">
                        <button
                          type="button"
                          aria-label={`Remove ${item.name}`}
                          onClick={() => setLines((cur) => cur.filter((l) => l.key !== line.key))}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          disabled={!canSubmit}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="px-5 pb-4 pt-2">
          <button
            type="button"
            onClick={() => searchRef.current?.focus()}
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/40 bg-primary/5 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            <Plus className="size-4" /> Add item
          </button>
        </div>
      </section>

      {/* ── notes and total ────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <StickyNote className="size-4 text-muted-foreground" /> Notes
          </p>
          <Textarea
            rows={3}
            placeholder="e.g. Required for weekend stock…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={!canSubmit}
          />
        </section>
        <section className="flex flex-col justify-between rounded-xl border bg-card p-5 shadow-soft">
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Estimated total</p>
            <p className="text-2xl font-bold tabular-nums">{money(total)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {lines.length} {lines.length === 1 ? 'item' : 'items'}
            </p>
          </div>
          {canSubmit ? (
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => save(false)} disabled={busy !== null}>
                {busy === 'draft' ? 'Saving…' : editingPending ? 'Save changes' : 'Save draft'}
              </Button>
              <Button onClick={() => save(true)} disabled={busy !== null}>
                {busy === 'submit' ? 'Sending…' : editingPending ? 'Save & keep pending' : 'Submit for approval'}
              </Button>
            </div>
          ) : (
            <p className="mt-4 text-right text-xs text-muted-foreground">
              You can read this request but not change it.
            </p>
          )}
        </section>
      </div>

      <ItemPricePanel
        itemId={panelFor}
        currency={currency}
        enteredPerBaseUnit={panelEntered}
        onUseLastPrice={(perBase) => {
          if (!panelLine) return
          const per = basePerUnit(panelLine.itemId, panelLine.unit) ?? 1
          update(panelLine.key, { unitCost: String(Math.round(perBase * per) / factor) })
          setPanelFor(null)
        }}
        onClose={() => setPanelFor(null)}
      />
    </div>
  )
}

const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm disabled:opacity-60'

function Field({
  icon,
  label,
  htmlFor,
  children,
}: {
  icon: React.ReactNode
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-xs text-muted-foreground [&>svg]:size-3.5">
        {icon}
        {label}
      </label>
      {children}
    </div>
  )
}
