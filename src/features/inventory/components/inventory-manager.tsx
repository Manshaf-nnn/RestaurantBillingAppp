'use client'

import * as React from 'react'
import type { StockUnit } from '@prisma/client'
import Link from 'next/link'
import { AlertTriangle, Eye, MoreVertical, Package, Pencil, Plus, Search, Settings2, Trash2, TrendingDown, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { formatMoney, parseMoney, toMajor } from '@/lib/money'
import { cn } from '@/lib/utils'
import { deleteInventoryItem, recordStockMovement, saveInventoryItem } from '../actions'
import { callAction } from '@/lib/use-action'


export interface InventoryRow {
  id: string
  name: string
  /*
   * Everything the edit form writes must also be readable here.
   *
   * It was not: `sku`, `storageArea`, `minStock`, `maxStock` and `supplierId`
   * were all absent, while the save payload sent them anyway — as blanks. So
   * opening Edit on any item and pressing Save silently erased its SKU, its
   * shelf and its supplier. The damage was invisible because nothing on this
   * screen displays those fields.
   */
  sku: string | null
  category: string | null
  unit: StockUnit
  quantity: number
  reorderLevel: number
  minStock: number
  maxStock: number | null
  costPerUnit: number
  supplierId: string | null
  supplierName: string | null
  storageArea: string | null
  expiryDate: string | null
  purchaseUnit: StockUnit | null
  unitsPerPurchaseUnit: number | null
}

export function InventoryManager({
  items: initial,
  suppliers,
  units,
  categories,
  currency,
  locale,
  canManage,
  branchName = null,
}: {
  items: InventoryRow[]
  suppliers: Array<{ id: string; name: string }>
  /*
   * The units and categories on offer, from the managed lists rather than a
   * hard-coded array. A unit switched off disappears from here; a category
   * becomes a dropdown instead of a text box people spell four ways.
   */
  units: Array<{ code: StockUnit; name: string; symbol: string }>
  categories: Array<{ id: string; name: string }>
  currency: string
  locale: string
  canManage: boolean
  /** Set when a single location is selected, so the quantities can say whose they are. */
  branchName?: string | null
}) {
  const [items, setItems] = React.useState(initial)
  const [search, setSearch] = React.useState('')
  const [view, setView] = React.useState<'ALL' | 'LOW' | 'EXPIRING'>('ALL')
  const [editing, setEditing] = React.useState<InventoryRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [movementFor, setMovementFor] = React.useState<InventoryRow | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setItems(initial), [initial])

  const isLow = React.useCallback(
    (item: InventoryRow) => item.quantity <= item.reorderLevel,
    [],
  )

  /**
   * Days until expiry, or null when the item has no date.
   *
   * Anchored to the UTC calendar day, not the local one. `setHours(0,0,0,0)`
   * resolves against the machine's timezone, so the server and the browser would
   * disagree by a day for much of the world and React would find different badge
   * text than it rendered — the same hydration failure class fixed elsewhere in
   * this app. UTC gives both sides the same answer.
   */
  const daysToExpiry = React.useCallback((item: InventoryRow): number | null => {
    if (!item.expiryDate) return null
    const now = new Date()
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const expiry = new Date(item.expiryDate)
    const expiryUtc = Date.UTC(
      expiry.getUTCFullYear(),
      expiry.getUTCMonth(),
      expiry.getUTCDate(),
    )
    return Math.round((expiryUtc - todayUtc) / 86_400_000)
  }, [])

  const lowStock = items.filter(isLow)
  const stockValue = items.reduce((sum, item) => sum + Math.round(item.quantity * item.costPerUnit), 0)
  const expiringSoon = items.filter((item) => {
    const days = daysToExpiry(item)
    return days !== null && days <= 7
  })

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return items.filter((item) => {
      if (view === 'LOW' && !isLow(item)) return false
      if (view === 'EXPIRING') {
        const days = daysToExpiry(item)
        if (days === null || days > 7) return false
      }
      if (!query) return true
      return (
        item.name.toLowerCase().includes(query) || Boolean(item.category?.toLowerCase().includes(query))
      )
    })
  }, [items, search, view, isLow, daysToExpiry])

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await callAction(() => deleteInventoryItem(id))
    if (result.ok) {
      setItems((current) => current.filter((item) => item.id !== id))
      toast.success('Item removed')
    } else {
      toast.error(result.error)
    }
  }

  return (
    <>
      <PageHeader
        title="Inventory"
        description={
          branchName
            ? `Quantities shown are what is on the shelf at ${branchName}.`
            : 'Track stock, get low-stock alerts, watch expiries'
        }
        actions={
          canManage ? (
            <>
              {/* Where the answer to "why isn't my category in the list" lives. */}
              <Button variant="outline" asChild>
                <Link href="/dashboard/inventory/setup">
                  <Settings2 /> Units &amp; categories
                </Link>
              </Button>
              <Button
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <Plus /> Add item
              </Button>
            </>
          ) : null
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Items tracked" value={items.length} icon={<Package />} />
        <StatCard label="Stock value" value={formatMoney(stockValue, currency, locale)} icon={<TrendingUp />} tone="primary" />
        <StatCard label="Low stock" value={lowStock.length} icon={<TrendingDown />} tone={lowStock.length ? 'warning' : 'default'} />
        <StatCard label="Expiring soon" value={expiringSoon.length} icon={<AlertTriangle />} tone={expiringSoon.length ? 'destructive' : 'default'} />
      </div>

      {/*
        The counts above are the reason someone opens this screen — "what do I
        need to reorder" — so they need to lead somewhere rather than just being
        read and then hunted for by eye down the table.
      */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search items…"
          startIcon={<Search />}
          className="max-w-sm"
        />
        <div className="inline-flex flex-wrap rounded-lg border bg-muted/40 p-1">
          {(
            [
              { key: 'ALL', label: `All${items.length ? ` · ${items.length}` : ''}` },
              { key: 'LOW', label: `Low stock${lowStock.length ? ` · ${lowStock.length}` : ''}` },
              {
                key: 'EXPIRING',
                label: `Expiring${expiringSoon.length ? ` · ${expiringSoon.length}` : ''}`,
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setView(tab.key)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                view === tab.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title={
            view === 'LOW'
              ? 'Nothing to reorder'
              : view === 'EXPIRING'
                ? 'Nothing expiring soon'
                : search
                  ? 'No matching items'
                  : 'No inventory items'
          }
          description={
            view === 'LOW'
              ? 'Every tracked item is above its reorder level.'
              : view === 'EXPIRING'
                ? 'No item is within seven days of its expiry date.'
                : search
                  ? 'Try a different name or category.'
                  : 'Add ingredients and supplies to track stock and get low-stock alerts.'
          }
          action={
            canManage && view === 'ALL' && !search ? (
              <Button
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <Plus /> Add your first item
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>In stock</TableHead>
                <TableHead className="hidden md:table-cell">Reorder at</TableHead>
                <TableHead className="hidden lg:table-cell">Cost / unit</TableHead>
                <TableHead className="hidden md:table-cell">Expiry</TableHead>
                <TableHead className="hidden lg:table-cell">Supplier</TableHead>
                {canManage ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => {
                const low = item.quantity <= item.reorderLevel
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      {/*
                        The detail page existed and worked, and nothing anywhere
                        on this screen linked to it — the name was a plain <p>.
                        Six other pages linked in; the one place people actually
                        look for an item did not.
                      */}
                      <Link
                        href={`/dashboard/inventory/${item.id}`}
                        className="font-medium hover:underline"
                      >
                        {item.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {[item.sku, item.category].filter(Boolean).join(' · ') || '\u00a0'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <span className={cn('font-semibold tabular-nums', low && 'text-destructive')}>
                        {item.quantity} {item.unit.toLowerCase()}
                      </span>
                      {low ? (
                        <Badge variant="warning" size="sm" className="ml-2">
                          Low
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {item.reorderLevel} {item.unit.toLowerCase()}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {formatMoney(item.costPerUnit, currency, locale)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {(() => {
                        const days = daysToExpiry(item)
                        if (days === null) return <span className="text-muted-foreground">—</span>
                        if (days < 0) return <Badge variant="destructive" size="sm">Expired</Badge>
                        if (days === 0) return <Badge variant="destructive" size="sm">Today</Badge>
                        if (days <= 7)
                          return (
                            <Badge variant="warning" size="sm">
                              {days}d left
                            </Badge>
                          )
                        return (
                          <span className="text-muted-foreground tabular-nums">{days}d</span>
                        )
                      })()}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {item.supplierName ?? '—'}
                    </TableCell>
                    {canManage ? (
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label="Actions">
                              <MoreVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/dashboard/inventory/${item.id}`}>
                                <Eye /> View details
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setMovementFor(item)}>
                              <TrendingUp /> Stock in/out
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setEditing(item)
                                setDialogOpen(true)
                              }}
                            >
                              <Pencil /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onClick={() => setDeleteId(item.id)}>
                              <Trash2 /> Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        item={editing}
        suppliers={suppliers}
        units={units}
        categories={categories}
        currency={currency}
      />
      <MovementDialog item={movementFor} onClose={() => setMovementFor(null)} />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Remove this item?"
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

/** The symbol from the managed list, falling back to the code. */
function unitLabel(code: string): string {
  return code.toLowerCase()
}

function ItemDialog({
  open,
  onOpenChange,
  item,
  suppliers,
  units,
  categories,
  currency,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: InventoryRow | null
  suppliers: Array<{ id: string; name: string }>
  units: Array<{ code: StockUnit; name: string; symbol: string }>
  categories: Array<{ id: string; name: string }>
  currency: string
}) {
  const [form, setForm] = React.useState({
    name: '',
    sku: '',
    category: '',
    unit: 'PIECE' as StockUnit,
    quantity: '0',
    reorderLevel: '0',
    minStock: '0',
    maxStock: '',
    costPerUnit: '',
    supplierId: '',
    storageArea: '',
    expiryDate: '',
    purchaseUnit: '' as StockUnit | '',
    unitsPerPurchaseUnit: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  /** The managed list, plus whatever this item already uses. */
  const offeredUnits = React.useMemo(() => {
    const list = [...units]
    for (const code of [item?.unit, item?.purchaseUnit]) {
      if (code && !list.some((u) => u.code === code)) {
        list.push({ code, name: code.toLowerCase(), symbol: code.toLowerCase() })
      }
    }
    return list
  }, [units, item])

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      name: item?.name ?? '',
      sku: item?.sku ?? '',
      category: item?.category ?? '',
      unit: item?.unit ?? 'PIECE',
      quantity: String(item?.quantity ?? 0),
      reorderLevel: String(item?.reorderLevel ?? 0),
      minStock: String(item?.minStock ?? 0),
      maxStock: item?.maxStock ? String(item.maxStock) : '',
      costPerUnit: item ? String(toMajor(item.costPerUnit, currency)) : '',
      // Was hard-coded to '' regardless of the item — the supplier-wiping bug.
      supplierId: item?.supplierId ?? '',
      storageArea: item?.storageArea ?? '',
      expiryDate: item?.expiryDate ? item.expiryDate.slice(0, 10) : '',
      purchaseUnit: item?.purchaseUnit ?? '',
      unitsPerPurchaseUnit: item?.unitsPerPurchaseUnit ? String(item.unitsPerPurchaseUnit) : '',
    })
  }, [open, item, currency])

  const save = async () => {
    setSaving(true)
    const result = await callAction(() => saveInventoryItem({
      id: item?.id,
      name: form.name,
      sku: form.sku,
      category: form.category,
      unit: form.unit,
      quantity: Number(form.quantity),
      reorderLevel: Number(form.reorderLevel),
      minStock: Number(form.minStock) || 0,
      maxStock: form.maxStock ? Number(form.maxStock) : null,
      costPerUnit: form.costPerUnit ? parseMoney(form.costPerUnit, currency) : 0,
      supplierId: form.supplierId,
      storageArea: form.storageArea,
      expiryDate: form.expiryDate,
      purchaseUnit: form.purchaseUnit,
      unitsPerPurchaseUnit: Number(form.unitsPerPurchaseUnit) || 0,
    }))
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Item saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit item' : 'New inventory item'}</DialogTitle>
          <DialogDescription>Set a reorder level to get low-stock alerts.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mozzarella" />
          </Field>
          <Field label="Item code / SKU">
            <Input
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
              placeholder="Optional — e.g. MOZ-1KG"
            />
          </Field>
          <Field label="Category">
            {categories.length > 0 ? (
              <Select
                value={form.category || '__none__'}
                onValueChange={(value) =>
                  setForm({ ...form, category: value === '__none__' ? '' : value })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {/*
                    The item's own category is always listed even if it has been
                    retired, otherwise opening Edit on an old item would quietly
                    move it to a different category — or to none.
                  */}
                  {[
                    ...categories.map((c) => c.name),
                    ...(form.category && !categories.some((c) => c.name === form.category)
                      ? [form.category]
                      : []),
                  ].map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Dairy"
              />
            )}
          </Field>
          <Field label="Unit">
            <Select value={form.unit} onValueChange={(value) => setForm({ ...form, unit: value as StockUnit })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/*
                  From the managed list, so a unit switched off stops being
                  offered. An item's own unit is always kept in the list, even
                  when retired — otherwise editing an old item would silently
                  change how its stock is measured, and a silent unit change is
                  a corrupted balance.
                */}
                {offeredUnits.map((unit) => (
                  <SelectItem key={unit.code} value={unit.code}>
                    {unit.name} ({unit.symbol})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {/*
            Only offered when creating. A balance is the result of movements, so
            changing it on an existing item is a stock adjustment — with a reason
            and a ledger entry — not a field edit. It used to be editable here and
            wrote straight to the row, which left the balance and its own history
            permanently disagreeing.
          */}
          {item?.id ? (
            <Field label="Quantity in stock">
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {form.quantity} — change this with <strong>Stock movement</strong> or a stock count.
              </p>
            </Field>
          ) : (
            <Field label="Opening quantity">
              <Input type="number" step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            </Field>
          )}
          <Field label="Bought as (optional)">
            <Select
              value={form.purchaseUnit || 'NONE'}
              onValueChange={(v) => setForm({ ...form, purchaseUnit: v === 'NONE' ? '' : (v as StockUnit) })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">Same as the unit above</SelectItem>
                {offeredUnits.map((u) => (
                  <SelectItem key={u.code} value={u.code}>
                    {u.name} ({u.symbol})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={`How many ${unitLabel(form.unit)} in one ${unitLabel(form.purchaseUnit || form.unit)}`}>
            <Input
              type="number"
              step="any"
              value={form.unitsPerPurchaseUnit}
              onChange={(e) => setForm({ ...form, unitsPerPurchaseUnit: e.target.value })}
              disabled={!form.purchaseUnit}
              placeholder={form.purchaseUnit ? 'e.g. 24' : 'Choose a purchase unit first'}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Buy in boxes, count in bottles. Receiving a delivery in boxes converts it for you.
            </p>
          </Field>
          <Field label="Reorder level">
            <Input type="number" step="any" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
            <p className="mt-1 text-xs text-muted-foreground">
              At or below this, the item is flagged low and appears in reorder suggestions.
            </p>
          </Field>
          <Field label="Minimum stock">
            <Input type="number" step="any" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} />
            <p className="mt-1 text-xs text-muted-foreground">
              A hard floor. Whichever of these two is higher is the one that triggers.
            </p>
          </Field>
          <Field label="Maximum stock (par level)">
            <Input
              type="number"
              step="any"
              value={form.maxStock}
              onChange={(e) => setForm({ ...form, maxStock: e.target.value })}
              placeholder="Optional"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Reorder suggestions top up to here. Above it, the item shows as overstocked.
            </p>
          </Field>
          <Field label="Storage area">
            <Input
              value={form.storageArea}
              onChange={(e) => setForm({ ...form, storageArea: e.target.value })}
              placeholder="Cold room"
            />
          </Field>
          <Field label={`Cost per unit (${currency})`}>
            <Input type="number" value={form.costPerUnit} onChange={(e) => setForm({ ...form, costPerUnit: e.target.value })} />
          </Field>
          <Field label="Expiry date">
            <Input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
          </Field>
          {suppliers.length ? (
            <Field label="Supplier" className="sm:col-span-2">
              <Select value={form.supplierId} onValueChange={(value) => setForm({ ...form, supplierId: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MovementDialog({ item, onClose }: { item: InventoryRow | null; onClose: () => void }) {
  const [type, setType] = React.useState<'PURCHASE' | 'WASTE' | 'ADJUSTMENT' | 'EXPIRY'>('PURCHASE')
  const [quantity, setQuantity] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (item) {
      setType('PURCHASE')
      setQuantity('')
      setReason('')
    }
  }, [item])

  const save = async () => {
    if (!item) return
    setSaving(true)
    const result = await callAction(() => recordStockMovement({
      itemId: item.id,
      type,
      quantity: Number(quantity),
      reason,
    }))
    setSaving(false)
    if (result.ok) {
      toast.success(`New quantity: ${result.data.quantity}`)
      onClose()
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Stock movement — {item?.name}</DialogTitle>
          <DialogDescription>Currently {item?.quantity} {item?.unit.toLowerCase()} in stock.</DialogDescription>
        </DialogHeader>
        <Field label="Type">
          <Select value={type} onValueChange={(value) => setType(value as typeof type)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PURCHASE">Stock in (purchase)</SelectItem>
              <SelectItem value="WASTE">Waste</SelectItem>
              <SelectItem value="EXPIRY">Expired</SelectItem>
              <SelectItem value="ADJUSTMENT">Adjustment (+/−)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Quantity" hint={type === 'ADJUSTMENT' ? 'Use a negative number to reduce' : undefined}>
          <Input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
